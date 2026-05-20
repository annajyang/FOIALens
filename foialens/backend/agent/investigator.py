import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncGenerator

from db.client import pool
from tools import TOOL_DEFINITIONS, dispatch_tool
from tools.haiku_utils import DO_MODEL, _openai
from .prompts import WorkspaceContext, build_system_prompt, build_user_turn

SONNET = DO_MODEL
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
        for _ in range(MAX_ITERATIONS):
            response = await _openai().chat.completions.create(
                model=SONNET,
                max_tokens=8192,
                messages=[
                    {"role": "system", "content": build_system_prompt(params.mode, params.prompt)},
                    *messages,
                ],
                tools=TOOL_DEFINITIONS,
            )

            msg = response.choices[0].message
            finish_reason = response.choices[0].finish_reason

            assistant_msg: dict = {"role": "assistant", "content": msg.content}
            if msg.tool_calls:
                assistant_msg["tool_calls"] = [
                    {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ]
            messages.append(assistant_msg)

            if finish_reason in ("stop", "length"):
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
                        final_text or None, json.dumps(trace), params.run_id,
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

            if finish_reason == "tool_calls" and msg.tool_calls:
                for tc in msg.tool_calls:
                    name = tc.function.name
                    input_data = json.loads(tc.function.arguments)

                    yield {"type": "status", "message": f"Calling {name}…"}

                    result = await dispatch_tool(
                        name, input_data,
                        params.workspace_id, params.run_id, known_entity_names,
                    )

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

                    yield {"type": "trace", "tool": name, "input": input_data, "resultSummary": result_summary, "timestamp": timestamp}
                    trace.append({"type": "tool_call", "tool": name, "input": input_data, "resultSummary": result_summary, "timestamp": timestamp})

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result),
                    })

        raise RuntimeError("Investigation exceeded the maximum iteration limit.")

    except Exception as exc:
        message = str(exc)
        await asyncio.gather(
            pool().execute(
                "UPDATE investigation_runs "
                "SET status = 'error', error = $1, trace = $2::jsonb, completed_at = NOW() "
                "WHERE id = $3",
                message, json.dumps(trace), params.run_id,
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
        json.dumps(merged_entities),
        json.dumps(merged_timeline),
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
