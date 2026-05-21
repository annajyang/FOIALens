import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncGenerator

from db.client import pool
from tools import TOOL_DEFINITIONS, dispatch_tool
from tools.haiku_utils import MODEL, call_with_backoff
from .prompts import WorkspaceContext, build_system_prompt, build_user_turn

SONNET = MODEL
MAX_ITERATIONS = 10


@dataclass
class InvestigationParams:
    workspace_id: str
    run_id: str
    mode: str
    prompt: str | None
    workspace_context: WorkspaceContext


async def run_investigation(params: InvestigationParams) -> AsyncGenerator[dict, None]:
    await pool().execute(
        "UPDATE workspaces SET status = 'investigating', updated_at = NOW() WHERE id = $1",
        params.workspace_id,
    )

    yield {
        "type": "status",
        "message": "Starting exploratory scan…" if params.mode == "exploratory" else "Starting directed investigation…",
    }

    messages: list[dict] = [{"role": "user", "content": build_user_turn(params.workspace_context)}]

    known_entity_names: set[str] = {e["name"].lower() for e in params.workspace_context.existing_entities}
    trace: list[dict] = []
    acc_entities: list[dict] = []
    acc_events: list[dict] = []
    angle_count = 0

    try:
        for i in range(MAX_ITERATIONS):
            is_final_turn = (i == MAX_ITERATIONS - 1)
            call_kwargs: dict = dict(
                model=SONNET,
                max_tokens=8192,
                messages=[
                    {"role": "system", "content": build_system_prompt(params.mode, params.prompt)},
                    *messages,
                ],
            )
            if not is_final_turn:
                call_kwargs["tools"] = TOOL_DEFINITIONS
            response = await call_with_backoff(**call_kwargs)

            msg = response.choices[0].message
            finish_reason = response.choices[0].finish_reason

            print(f"\n[llm] iter={i} finish={finish_reason} tools={len(msg.tool_calls or [])}", flush=True)
            if msg.content:
                print(f"[llm] text: {msg.content[:400]}", flush=True)
            for tc in (msg.tool_calls or []):
                print(f"[llm] tool_call: {tc.function.name} args={tc.function.arguments[:200]}", flush=True)

            # Collect tool calls: prefer API tool_calls; fall back to <tool_call> text blocks
            # that some open-source models (e.g. Qwen) emit instead of the function-calling API.
            api_calls = msg.tool_calls or []
            text_calls = _parse_text_tool_calls(msg.content or "") if not api_calls else []
            all_calls = api_calls or text_calls   # one source or the other, never both

            # Build the assistant message for the conversation history
            assistant_msg: dict = {"role": "assistant", "content": msg.content}
            if api_calls:
                assistant_msg["tool_calls"] = [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in api_calls
                ]
            elif text_calls:
                print(f"[llm] found {len(text_calls)} text-format tool call(s), executing", flush=True)
                assistant_msg["tool_calls"] = [
                    {"id": tc["id"], "type": "function",
                     "function": {"name": tc["name"], "arguments": json.dumps(tc["args"])}}
                    for tc in text_calls
                ]
            messages.append(assistant_msg)

            if not all_calls:
                # No tool calls → final response
                # If nothing was proposed yet, force one more tool-enabled pass.
                if angle_count == 0 and not is_final_turn:
                    messages.append({"role": "user", "content":
                        "You have not proposed any story angles yet. "
                        "Review your search results above and call propose_angle at least once "
                        "with the most newsworthy finding, even if confidence is low."})
                    continue

                final_text = (msg.content or "").strip()
                trace.append({"type": "final", "content": final_text, "timestamp": _now()})
                new_entity_count, new_event_count = await _merge_into_workspace(
                    params.workspace_id, params.run_id, acc_entities, acc_events,
                    params.workspace_context,
                )
                await asyncio.gather(
                    pool().execute(
                        "UPDATE investigation_runs "
                        "SET status = 'done', summary = $1, trace = $2::jsonb, completed_at = NOW() "
                        "WHERE id = $3",
                        final_text or None, trace, params.run_id,
                    ),
                    pool().execute(
                        "UPDATE workspaces SET status = 'active', updated_at = NOW() WHERE id = $1",
                        params.workspace_id,
                    ),
                )
                yield {
                    "type": "done",
                    "runId": params.run_id,
                    "summary": final_text,
                    "angleCount": angle_count,
                    "newEntityCount": new_entity_count,
                    "newTimelineEventCount": new_event_count,
                }
                return

            # Execute tool calls (from API or from parsed text)
            for tc in all_calls:
                tc_id   = tc.id if api_calls else tc["id"]
                tc_name = (tc.function.name if api_calls else tc["name"]) or ""
                tc_args = tc.function.arguments if api_calls else json.dumps(tc["args"])

                # Strip special tokens some models leak into tool names
                m = re.match(r'^[a-zA-Z0-9_]+', tc_name)
                name = m.group() if m else tc_name
                if name != tc_name:
                    print(f"[tool] sanitized name {tc_name!r} → {name!r}", flush=True)

                input_data = json.loads(tc_args)
                yield {"type": "status", "message": f"Calling {name}…"}

                result = await dispatch_tool(name, input_data,
                                             params.workspace_id, params.run_id, known_entity_names)

                if name == "extract_entities":
                    extracted = result.get("entities", [])
                    for e in extracted:
                        known_entity_names.add(e["name"].lower())
                    acc_entities = _merge_entities(acc_entities, extracted)

                if name == "build_timeline":
                    acc_events = _merge_events(acc_events, result.get("events", []))

                if name == "propose_angle":
                    angle = await _fetch_angle(result["angleId"])
                    if angle:
                        yield {"type": "angle_proposed", "angle": angle}
                        angle_count += 1

                timestamp = _now()
                result_summary = _summarize(name, result)
                yield {"type": "trace", "tool": name, "input": input_data,
                       "resultSummary": result_summary, "timestamp": timestamp}
                trace.append({"type": "tool_call", "tool": name, "input": input_data,
                               "resultSummary": result_summary, "timestamp": timestamp})
                messages.append({"role": "tool", "tool_call_id": tc_id, "content": json.dumps(result)})

        # Should be unreachable: final turn has no tools so always produces end_turn.
        # Guard against unexpected model behavior by flushing whatever we have.
        new_entity_count, new_event_count = await _merge_into_workspace(
            params.workspace_id, params.run_id, acc_entities, acc_events, params.workspace_context,
        )
        await asyncio.gather(
            pool().execute(
                "UPDATE investigation_runs SET status = 'done', trace = $1::jsonb, completed_at = NOW() WHERE id = $2",
                trace, params.run_id,
            ),
            pool().execute(
                "UPDATE workspaces SET status = 'active', updated_at = NOW() WHERE id = $1",
                params.workspace_id,
            ),
        )
        yield {"type": "done", "runId": params.run_id, "summary": "", "angleCount": angle_count,
               "newEntityCount": new_entity_count, "newTimelineEventCount": new_event_count}

    except Exception as exc:
        message = str(exc)
        await asyncio.gather(
            pool().execute(
                "UPDATE investigation_runs "
                "SET status = 'error', error = $1, trace = $2::jsonb, completed_at = NOW() "
                "WHERE id = $3",
                message, trace, params.run_id,
            ),
            pool().execute(
                "UPDATE workspaces SET status = 'active', updated_at = NOW() WHERE id = $1",
                params.workspace_id,
            ),
            return_exceptions=True,
        )
        yield {"type": "error", "message": message}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _fetch_angle(angle_id: str) -> dict | None:
    row = await pool().fetchrow("SELECT * FROM angles WHERE id = $1", angle_id)
    if not row:
        return None
    return {
        "id":             str(row["id"]),
        "workspaceId":    str(row["workspace_id"]),
        "runId":          str(row["run_id"]),
        "title":          row["title"],
        "summary":        row["summary"],
        "newsworthiness": row["newsworthiness"],
        "angleType":      row["angle_type"],
        "evidence":       row["evidence"],
        "citations":      row["citations"],
        "status":         row["status"],
        "createdAt":      row["created_at"].isoformat(),
        "updatedAt":      row["updated_at"].isoformat(),
    }


async def _merge_into_workspace(
    workspace_id: str,
    run_id: str,
    new_entities: list[dict],
    new_events: list[dict],
    ctx: WorkspaceContext,
) -> tuple[int, int]:
    existing_names = {e["name"].lower() for e in ctx.existing_entities}
    new_entity_count = sum(1 for e in new_entities if e["name"].lower() not in existing_names)

    merged_entities = _merge_entities(ctx.existing_entities, new_entities, first_seen_run_id=run_id)

    seen_keys = {_event_key(e) for e in ctx.existing_timeline}
    merged_timeline = list(ctx.existing_timeline)
    new_event_count = 0
    for e in new_events:
        k = _event_key(e)
        if k not in seen_keys:
            seen_keys.add(k)
            merged_timeline.append({**e, "firstSeenRunId": run_id})
            new_event_count += 1

    await pool().execute(
        "UPDATE workspaces SET entities = $1::jsonb, timeline = $2::jsonb, updated_at = NOW() WHERE id = $3",
        merged_entities,
        merged_timeline,
        workspace_id,
    )

    return new_entity_count, new_event_count


def _merge_entities(
    existing: list[dict],
    incoming: list[dict],
    *,
    first_seen_run_id: str | None = None,
) -> list[dict]:
    by_name: dict[str, dict] = {e["name"].lower(): dict(e) for e in existing}
    for e in incoming:
        key = e["name"].lower()
        if key in by_name:
            by_name[key]["mentions"] += e["mentions"]
            for p in e["pageRefs"]:
                if p not in by_name[key]["pageRefs"]:
                    by_name[key]["pageRefs"].append(p)
        else:
            by_name[key] = {**e, **({"firstSeenRunId": first_seen_run_id} if first_seen_run_id else {})}
    return list(by_name.values())


def _merge_events(existing: list[dict], incoming: list[dict]) -> list[dict]:
    seen = {_event_key(e) for e in existing}
    result = list(existing)
    for e in incoming:
        k = _event_key(e)
        if k not in seen:
            seen.add(k)
            result.append(e)
    return result


def _event_key(e: dict) -> str:
    return f"{e['date']}|{e['description'][:80]}"


def _parse_text_tool_calls(content: str) -> list[dict]:
    """Parse <tool_call>...</tool_call> blocks emitted by models like Qwen.
    Returns a list of {"id": str, "name": str, "args": dict}.
    Qwen format: {"name": "tool_name", "arguments": {...}}
    """
    results = []
    for idx, block in enumerate(re.findall(r'<tool_call>(.*?)</tool_call>', content, re.DOTALL)):
        try:
            parsed = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        name = parsed.get("name")
        args = parsed.get("arguments") or parsed.get("args") or {}
        if not name:
            continue
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                continue
        results.append({"id": f"text_{idx}", "name": name, "args": args})
    return results


def _summarize(tool_name: str, result: dict) -> str:
    match tool_name:
        case "search_documents":
            return f"Found {len(result.get('results', []))} chunk(s)"
        case "extract_entities":
            return f"Extracted {len(result.get('entities', []))} entities ({result.get('newCount', 0)} new)"
        case "build_timeline":
            return f"Found {len(result.get('events', []))} dated event(s)"
        case "propose_angle":
            return f"Angle proposed: {result.get('angleId')}"
        case _:
            return json.dumps(result)[:120]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
