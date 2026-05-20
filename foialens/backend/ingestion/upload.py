import os
import uuid

from fastapi import UploadFile

from db.client import pool
from storage.spaces import upload_bytes
from .pdf_extractor import extract_pages
from .chunker import chunk_pages
from .embedder import embed_texts, to_vector_string

_SPACES_CONFIGURED = all(
    os.environ.get(k) for k in ('DO_SPACES_ENDPOINT', 'DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET')
)


async def create_workspace_and_ingest(name: str, files: list[UploadFile]) -> dict:
    row = await pool().fetchrow(
        "INSERT INTO workspaces (name, status) VALUES ($1, 'ingesting') RETURNING id",
        name.strip(),
    )
    workspace_id = str(row["id"])
    result = await ingest_files(files, workspace_id)
    return {"workspaceId": workspace_id, **result}


async def ingest_files(files: list[UploadFile], workspace_id: str) -> dict:
    total_chunks = 0
    for file in files:
        total_chunks += await _ingest_one(file, workspace_id)
    await pool().execute(
        "UPDATE workspaces SET status = 'ready', updated_at = NOW() WHERE id = $1",
        workspace_id,
    )
    return {"documentCount": len(files), "chunkCount": total_chunks}


async def _ingest_one(file: UploadFile, workspace_id: str) -> int:
    content = await file.read()
    pages = extract_pages(content)
    if not pages:
        raise ValueError(
            f"{file.filename} contains no extractable text. "
            "Scanned PDFs require OCR pre-processing before upload."
        )

    chunks = chunk_pages(pages)
    embeddings = await embed_texts([c.content for c in chunks])
    page_count = max(p.page for p in pages)

    doc_uuid = str(uuid.uuid4())
    file_key: str | None = None
    if _SPACES_CONFIGURED:
        file_key = f"documents/{workspace_id}/{doc_uuid}/{file.filename}"
        await upload_bytes(content, file_key, content_type='application/pdf')

    async with pool().acquire() as conn:
        async with conn.transaction():
            doc = await conn.fetchrow(
                "INSERT INTO documents (id, workspace_id, filename, page_count, byte_size, file_key) "
                "VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
                doc_uuid, workspace_id, file.filename, page_count, len(content), file_key,
            )
            doc_id = str(doc["id"])

            for chunk, embedding in zip(chunks, embeddings):
                await conn.execute(
                    "INSERT INTO chunks "
                    "  (document_id, workspace_id, content, start_page, end_page, "
                    "   chunk_index, token_count, embedding) "
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)",
                    doc_id, workspace_id, chunk.content,
                    chunk.start_page, chunk.end_page,
                    chunk.chunk_index, chunk.token_count,
                    to_vector_string(embedding),
                )

    return len(chunks)
