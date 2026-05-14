from db.client import pool
from ingestion.embedder import embed_texts, to_vector_string


async def search_documents(query: str, workspace_id: str, limit: int = 10) -> dict:
    embeddings = await embed_texts([query])
    vec = to_vector_string(embeddings[0])

    rows = await pool().fetch(
        """
        SELECT c.id AS chunk_id, c.content, c.start_page, c.end_page,
               d.filename AS document_name,
               1 - (c.embedding <=> $1::vector) AS similarity
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.workspace_id = $2
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3
        """,
        vec, workspace_id, limit,
    )

    return {
        "results": [
            {
                "chunkId":      str(r["chunk_id"]),
                "content":      r["content"],
                "startPage":    r["start_page"],
                "endPage":      r["end_page"],
                "documentName": r["document_name"],
                "similarity":   float(r["similarity"]),
            }
            for r in rows
        ]
    }
