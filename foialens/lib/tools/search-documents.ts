import pool from '@/lib/db/client';
import { embedTexts, toVectorString } from '@/lib/ingestion/embedder';

export interface SearchResult {
  chunkId: string;       // used internally by build_timeline for deduplication
  content: string;
  startPage: number;
  endPage: number;
  documentName: string;
  similarity: number;    // 0–1, higher = more similar
}

export async function searchDocuments(
  query: string,
  workspaceId: string,
  limit = 10,
): Promise<{ results: SearchResult[] }> {
  const clampedLimit = Math.min(limit, 20);

  const [embedding] = await embedTexts([query]);
  const vectorStr = toVectorString(embedding);

  const { rows } = await pool.query<{
    id: string;
    content: string;
    start_page: number;
    end_page: number;
    filename: string;
    similarity: string;
  }>(
    `SELECT
       c.id,
       c.content,
       c.start_page,
       c.end_page,
       d.filename,
       (1 - (c.embedding <=> $1::vector))::text AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.workspace_id = $2
       AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, workspaceId, clampedLimit],
  );

  return {
    results: rows.map(r => ({
      chunkId:      r.id,
      content:      r.content,
      startPage:    r.start_page,
      endPage:      r.end_page,
      documentName: r.filename,
      similarity:   parseFloat(r.similarity),
    })),
  };
}
