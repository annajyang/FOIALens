import asyncio

from .haiku_utils import HAIKU, _openai, extract_text, parse_json
from .search_documents import search_documents

TIMELINE_QUERIES = [
    "signed dated effective agreement",
    "approved authorized ordered decision",
    "meeting minutes conference call scheduled",
    "announced commenced expired deadline",
    "awarded contract began terminated",
]


async def build_timeline(workspace_id: str) -> dict:
    chunks = await _gather_chunks(workspace_id)
    if not chunks:
        return {"events": []}

    context = "\n\n---\n\n".join(f"[p.{c['startPage']}] {c['content']}" for c in chunks)

    response = await _openai().chat.completions.create(
        model=HAIKU,
        max_tokens=2048,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a precise information extraction system. "
                    "Return ONLY valid JSON with no prose, preamble, or markdown fences."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Extract every dated event from the document text below.\n"
                    "Only include events that have a specific or approximate date attached.\n\n"
                    "Return a JSON array where each element has exactly these fields:\n"
                    '- "date": ISO 8601 string (e.g. "2021-03-15") or "circa YYYY" (string)\n'
                    '- "description": what happened (string)\n'
                    '- "significance": why this event matters to an investigation (string)\n'
                    '- "pageRefs": page numbers where this event appears (number[])\n'
                    '- "confidence": "high" if date is explicit, "medium" if inferred, "low" if approximate\n\n'
                    f"Document text:\n{context}\n\nReturn ONLY the JSON array."
                ),
            },
        ],
    )

    parsed = parse_json(extract_text(response))
    if not isinstance(parsed, list):
        return {"events": []}

    events = [e for e in parsed if _is_valid(e)]
    events.sort(key=_sort_key)
    return {"events": events}


async def _gather_chunks(workspace_id: str) -> list[dict]:
    results = await asyncio.gather(
        *[search_documents(query, workspace_id, limit=5) for query in TIMELINE_QUERIES]
    )
    seen: set[str] = set()
    chunks: list[dict] = []
    for result in results:
        for r in result["results"]:
            if r["chunkId"] not in seen:
                seen.add(r["chunkId"])
                chunks.append(r)
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
