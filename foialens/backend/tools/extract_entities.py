from db.client import pool
from .haiku_utils import HAIKU, call_with_backoff, extract_text, parse_json

MAX_CHUNKS = 20

VALID_TYPES = {"person", "organization", "date", "amount", "location"}


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

    parsed = parse_json(extract_text(response))
    if not isinstance(parsed, list):
        return {"entities": [], "newCount": 0}

    entities = [e for e in parsed if _is_valid(e)]
    new_count = sum(1 for e in entities if e["name"].lower() not in known_names)

    return {"entities": entities, "newCount": new_count}


async def _fetch_chunks(scope: str, workspace_id: str) -> list:
    if scope == "full":
        return await pool().fetch(
            "SELECT content, start_page FROM chunks "
            "WHERE workspace_id = $1 ORDER BY document_id, chunk_index LIMIT $2",
            workspace_id, MAX_CHUNKS,
        )
    return await pool().fetch(
        "SELECT content, start_page FROM chunks "
        "WHERE workspace_id = $1 AND document_id = $2 ORDER BY chunk_index LIMIT $3",
        workspace_id, scope, MAX_CHUNKS,
    )


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
