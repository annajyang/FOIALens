import asyncio

from db.client import pool
from .haiku_utils import HAIKU, call_with_backoff, extract_text, parse_json
from .search_documents import search_documents

_BASE_QUERIES = [
    "signed dated effective agreement",
    "approved authorized ordered decision",
    "meeting minutes conference call scheduled",
    "announced commenced expired deadline",
    "awarded contract began terminated",
]


async def build_timeline(workspace_id: str, entity_names: list[str] | None = None) -> dict:
    # entity_names comes from known_entity_names in the investigator loop —
    # names extracted during the current run by extract_entities. Fall back to
    # the workspace's accumulated entities from prior runs if nothing was passed.
    if not entity_names:
        ws_row = await pool().fetchrow("SELECT entities FROM workspaces WHERE id = $1", workspace_id)
        entity_names = [e["name"] for e in (ws_row["entities"] or [])] if ws_row else []

    chunks = await _gather_chunks(workspace_id, entity_names)
    if not chunks:
        return {"events": []}

    context = "\n\n---\n\n".join(f"[p.{c['startPage']}] {c['content']}" for c in chunks)

    _PREFILL = '{"events": ['
    response = await call_with_backoff(
        model=HAIKU,
        max_tokens=8192,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a data extraction API for legal and investigative research. "
                    "You output only raw JSON with no prose, no markdown, no explanation."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Extract every dated event from the document text below.\n"
                    "Only include events that have a specific or approximate date attached.\n\n"
                    'Continue the JSON that has already been started. Each element:\n'
                    '{"date": "2021-03-15", "description": "...", "significance": "...", '
                    '"pageRefs": [1], "confidence": "high"}\n\n'
                    '"date" is ISO 8601 or "circa YYYY". '
                    '"confidence": "high" (explicit date), "medium" (inferred), "low" (approximate).\n\n'
                    f"Document text:\n{context}"
                ),
            },
            {
                "role": "assistant",
                "content": _PREFILL,
            },
        ],
    )

    raw_text = _PREFILL + extract_text(response)
    print(f"[build_timeline] raw response ({len(raw_text)} chars): {raw_text[:300]!r}", flush=True)
    parsed = parse_json(raw_text)
    # Accept {"events": [...]} wrapper or bare list
    if isinstance(parsed, dict):
        parsed = parsed.get("events", parsed.get("event", []))
    if not isinstance(parsed, list):
        print(f"[build_timeline] parse_json failed; raw={raw_text[:300]!r}", flush=True)
        return {"events": []}

    print(f"[build_timeline] parsed {len(parsed)} items, {sum(1 for e in parsed if _is_valid(e))} valid", flush=True)
    events = [e for e in parsed if _is_valid(e)]
    events.sort(key=_sort_key)
    return {"events": events}


async def _gather_chunks(workspace_id: str, entity_names: list[str]) -> list[dict]:
    queries = list(_BASE_QUERIES)
    for name in entity_names[:5]:
        queries.append(f"{name} date signed approved awarded")

    db_count = await pool().fetchval("SELECT count(*)::int FROM chunks WHERE workspace_id = $1", workspace_id)
    print(f"[build_timeline] workspace_id={workspace_id!r} db_chunk_count={db_count}", flush=True)

    results = await asyncio.gather(
        *[search_documents(q, workspace_id, limit=5) for q in queries]
    )

    seen: set[str] = set()
    chunks: list[dict] = []
    for q, result in zip(queries, results):
        hits = result.get("results", [])
        print(f"[build_timeline] query={q!r:.50} → {len(hits)} hits", flush=True)
        for r in hits:
            if r["chunkId"] not in seen:
                seen.add(r["chunkId"])
                chunks.append(r)

    print(f"[build_timeline] total unique chunks: {len(chunks)}", flush=True)
    return chunks


def _is_valid(e: object) -> bool:
    if not isinstance(e, dict):
        return False
    return (
        isinstance(e.get("date"), str)
        and isinstance(e.get("description"), str)
        and isinstance(e.get("significance"), str)
        and isinstance(e.get("pageRefs"), list)
        and e.get("confidence") in ("high", "medium", "low")
    )


def _sort_key(e: dict) -> tuple[int, str]:
    return (1 if e["date"].startswith("circa") else 0, e["date"])
