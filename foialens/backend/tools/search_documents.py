import asyncio

from db.client import pool
from ingestion.embedder import embed_texts, to_vector_string

# Reciprocal Rank Fusion constant — higher = smoother blend, less sensitive to top rank
_RRF_K = 60


async def search_documents(query: str, workspace_id: str, limit: int = 10) -> dict:
    limit = min(limit, 20)
    vec = to_vector_string((await embed_texts([query]))[0])

    # Run semantic (vector) and keyword (full-text) searches in parallel.
    # Keyword search uses the GIN index on to_tsvector('english', content).
    sem_rows, kw_rows = await asyncio.gather(
        pool().fetch(
            """
            SELECT c.id::text AS chunk_id, c.content, c.start_page, c.end_page,
                   d.filename AS document_name,
                   1 - (c.embedding <=> $1::vector) AS similarity
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.workspace_id = $2
            ORDER BY c.embedding <=> $1::vector
            LIMIT $3
            """,
            vec, workspace_id, limit * 2,
        ),
        pool().fetch(
            """
            SELECT c.id::text AS chunk_id, c.content, c.start_page, c.end_page,
                   d.filename AS document_name
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.workspace_id = $1
              AND to_tsvector('english', c.content) @@ plainto_tsquery('english', $2)
            ORDER BY ts_rank(to_tsvector('english', c.content),
                             plainto_tsquery('english', $2)) DESC
            LIMIT $3
            """,
            workspace_id, query, limit * 2,
        ),
    )

    # Build chunk data map — semantic rows carry the similarity score.
    chunks: dict[str, dict] = {}
    for r in sem_rows:
        chunks[r["chunk_id"]] = {
            "content":       r["content"],
            "start_page":    r["start_page"],
            "end_page":      r["end_page"],
            "document_name": r["document_name"],
            "similarity":    float(r["similarity"]),
        }
    for r in kw_rows:
        if r["chunk_id"] not in chunks:
            chunks[r["chunk_id"]] = {
                "content":       r["content"],
                "start_page":    r["start_page"],
                "end_page":      r["end_page"],
                "document_name": r["document_name"],
                "similarity":    0.0,  # no vector score for keyword-only hits
            }

    # RRF: score = 1/(K + rank_semantic) + 1/(K + rank_keyword)
    scores: dict[str, float] = {}
    for rank, r in enumerate(sem_rows):
        cid = r["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (_RRF_K + rank + 1)
    for rank, r in enumerate(kw_rows):
        cid = r["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (_RRF_K + rank + 1)

    top = sorted(scores, key=scores.__getitem__, reverse=True)[:limit]

    return {
        "results": [
            {
                "chunkId":      cid,
                "content":      chunks[cid]["content"],
                "startPage":    chunks[cid]["start_page"],
                "endPage":      chunks[cid]["end_page"],
                "documentName": chunks[cid]["document_name"],
                "similarity":   chunks[cid]["similarity"],
            }
            for cid in top
        ]
    }
