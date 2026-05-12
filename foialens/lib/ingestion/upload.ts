import pool from '@/lib/db/client';
import { extractPages } from './pdf-extractor';
import { chunkPages } from './chunker';
import { embedTexts, toVectorString } from './embedder';

export interface IngestResult {
  documentCount: number;
  chunkCount: number;
}

export interface CreateWorkspaceResult extends IngestResult {
  workspaceId: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createWorkspaceAndIngest(
  name: string,
  files: File[],
): Promise<CreateWorkspaceResult> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name, status) VALUES ($1, 'ingesting') RETURNING id`,
    [name.trim()],
  );
  const workspaceId = rows[0].id;

  const result = await ingestFiles(files, workspaceId);
  return { workspaceId, ...result };
}

export async function ingestFiles(
  files: File[],
  workspaceId: string,
): Promise<IngestResult> {
  let totalChunks = 0;

  for (const file of files) {
    const added = await ingestOne(file, workspaceId);
    totalChunks += added;
  }

  await pool.query(
    `UPDATE workspaces SET status = 'ready', updated_at = NOW() WHERE id = $1`,
    [workspaceId],
  );

  return { documentCount: files.length, chunkCount: totalChunks };
}

// ── Per-file pipeline ─────────────────────────────────────────────────────────

async function ingestOne(file: File, workspaceId: string): Promise<number> {
  const buffer = Buffer.from(await file.arrayBuffer());

  const pages = await extractPages(buffer);
  if (pages.length === 0) {
    throw new Error(
      `${file.name} contains no extractable text. ` +
      `Scanned PDFs require OCR pre-processing before upload.`,
    );
  }

  const chunks = chunkPages(pages);
  const embeddings = await embedTexts(chunks.map(c => c.content));

  const pageCount = Math.max(...pages.map(p => p.page));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, filename, page_count, byte_size)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [workspaceId, file.name, pageCount, file.size],
    );
    const documentId = rows[0].id;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await client.query(
        `INSERT INTO chunks
           (document_id, workspace_id, content, start_page, end_page,
            chunk_index, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [
          documentId,
          workspaceId,
          c.content,
          c.startPage,
          c.endPage,
          c.chunkIndex,
          c.tokenCount,
          toVectorString(embeddings[i]),
        ],
      );
    }

    await client.query('COMMIT');
    return chunks.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
