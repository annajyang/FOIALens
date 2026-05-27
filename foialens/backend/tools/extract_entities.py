import asyncio

from db.client import pool
from .haiku_utils import HAIKU, call_with_backoff, extract_text, parse_json
from .search_documents import search_documents

MAX_CHUNKS = 50
VALID_TYPES = {"person", "organization", "date", "amount", "location"}

# Queries designed to surface entity-dense chunks across different entity types.
_ENTITY_QUERIES = [
    "official director manager authorized signed by",
    "organization company corporation contractor vendor",
    "payment amount cost fee million dollars awarded",
    "employee staff personnel appointed role title position",
]


async def extract_entities(
    scope: str,
    workspace_id: str,
    known_names: set[str] | None = None,
) -> dict:
    if known_names is None:
        known_names = set()

    chunks = await _fetch_chunks(scope, workspace_id)
    if not chunks:
        return {"entities": [], "newCount": 0}

    context = "\n\n---\n\n".join(f"[p.{r['start_page']}] {r['content']}" for r in chunks)

    response = await call_with_backoff(
        model=HAIKU,
        max_tokens=8192,
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
                    "Extract every named entity from the document text below.\n\n"
                    "Return a JSON array where each element has exactly these fields:\n"
                    '- "name": entity name (string)\n'
                    '- "type": one of "person" | "organization" | "date" | "amount" | "location"\n'
                    '- "mentions": approximate count of times mentioned (number)\n'
                    '- "pageRefs": page numbers where found (number[])\n'
                    '- "representativeContext": one sentence showing the entity in context (string)\n\n'
                    f"Document text:\n{context}\n\nReturn ONLY the JSON array."
                ),
            },
        ],
    )

    raw_text = extract_text(response)
    parsed = parse_json(raw_text)
    if not isinstance(parsed, list):
        print(f"[extract_entities] parse_json failed; raw={raw_text[:300]!r}", flush=True)
        return {"entities": [], "newCount": 0}

    entities = [e for e in parsed if _is_valid(e)]
    new_count = sum(1 for e in entities if e["name"].lower() not in known_names)

    return {"entities": entities, "newCount": new_count}


async def _fetch_chunks(scope: str, workspace_id: str) -> list:
    if scope != "full":
        # Single-document extraction — fetch in order
        return await pool().fetch(
            "SELECT content, start_page FROM chunks "
            "WHERE workspace_id = $1 AND document_id = $2 ORDER BY chunk_index LIMIT $3",
            workspace_id, scope, MAX_CHUNKS,
        )

    # Full-corpus extraction: use targeted semantic searches to find entity-rich
    # chunks instead of reading the first N chunks in document order.
    results = await asyncio.gather(
        *[search_documents(q, workspace_id, limit=12) for q in _ENTITY_QUERIES]
    )

    seen: set[str] = set()
    chunks: list[dict] = []
    for result in results:
        for r in result["results"]:
            if r["chunkId"] not in seen:
                seen.add(r["chunkId"])
                chunks.append({"start_page": r["startPage"], "content": r["content"]})

    return chunks[:MAX_CHUNKS]


def _is_valid(e: object) -> bool:
    if not isinstance(e, dict):
        return False
    return (
        isinstance(e.get("name"), str)
        and e.get("type") in VALID_TYPES
        and isinstance(e.get("mentions"), (int, float))
        and isinstance(e.get("pageRefs"), list)
        and isinstance(e.get("representativeContext"), str)
    )
