import asyncio

from db.client import pool
from .haiku_utils import HAIKU, call_with_backoff, extract_text, parse_json
from .search_documents import search_documents

MAX_CHUNKS = 50
VALID_TYPES = {"person", "organization", "location"}

# Queries designed to surface entity-dense chunks across different entity types.
_ENTITY_QUERIES = [
    "signed by director secretary chief officer commissioner",
    "department agency bureau division office city county state",
    "contractor vendor company corporation LLC incorporated",
    "appointed hired promoted transferred reassigned resigned",
    "located address headquarters district region jurisdiction",
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

    _SCHEMA = {
        "type": "json_schema",
        "json_schema": {
            "name": "entity_extraction",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "entities": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name":                  {"type": "string"},
                                "type":                  {"type": "string", "enum": ["person", "organization", "location"]},
                                "mentions":              {"type": "number"},
                                "pageRefs":              {"type": "array", "items": {"type": "number"}},
                                "representativeContext": {"type": "string"},
                            },
                            "required": ["name", "type", "mentions", "pageRefs", "representativeContext"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["entities"],
                "additionalProperties": False,
            },
        },
    }
    response = await call_with_backoff(
        model=HAIKU,
        max_tokens=8192,
        response_format=_SCHEMA,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a data extraction API for legal and investigative research. "
                    "Extract named persons, organizations, and locations. "
                    "Focus on named officials and staff, government agencies, contractors, vendors, and named places."
                ),
            },
            {
                "role": "user",
                "content": f"Document text:\n{context}",
            },
        ],
    )

    raw_text = extract_text(response)
    print(f"[extract_entities] raw response ({len(raw_text)} chars): {raw_text[:300]!r}", flush=True)
    parsed = parse_json(raw_text)
    if isinstance(parsed, dict):
        parsed = parsed.get("entities", [])
    if not isinstance(parsed, list):
        print(f"[extract_entities] parse_json failed; raw={raw_text[:300]!r}", flush=True)
        return {"entities": [], "newCount": 0}

    print(f"[extract_entities] parsed {len(parsed)} items, {sum(1 for e in parsed if _is_valid(e))} valid", flush=True)
    entities = [e for e in parsed if _is_valid(e)]
    new_count = sum(1 for e in entities if e["name"].lower() not in known_names)

    return {"entities": entities, "newCount": new_count}


async def _fetch_chunks(scope: str, workspace_id: str) -> list:
    if scope != "full":
        rows = await pool().fetch(
            "SELECT content, start_page FROM chunks "
            "WHERE workspace_id = $1 AND document_id = $2 ORDER BY chunk_index LIMIT $3",
            workspace_id, scope, MAX_CHUNKS,
        )
        print(f"[extract_entities] single-doc fetch: {len(rows)} chunks", flush=True)
        return rows

    db_count = await pool().fetchval("SELECT count(*)::int FROM chunks WHERE workspace_id = $1", workspace_id)
    print(f"[extract_entities] workspace_id={workspace_id!r} db_chunk_count={db_count}", flush=True)

    results = await asyncio.gather(
        *[search_documents(q, workspace_id, limit=12) for q in _ENTITY_QUERIES]
    )

    seen: set[str] = set()
    chunks: list[dict] = []
    for q, result in zip(_ENTITY_QUERIES, results):
        hits = result.get("results", [])
        print(f"[extract_entities] query={q!r:.50} → {len(hits)} hits", flush=True)
        for r in hits:
            if r["chunkId"] not in seen:
                seen.add(r["chunkId"])
                chunks.append({"start_page": r["startPage"], "content": r["content"]})

    print(f"[extract_entities] total unique chunks: {len(chunks)}", flush=True)
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
