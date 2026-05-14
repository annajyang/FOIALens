import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db/client';
import { ingestFiles } from '@/lib/ingestion/upload';
import { validateFiles, err } from '@/lib/api/file-validation';

export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: { workspaceId: string } },
) {
  const { workspaceId } = params;

  const ws = await pool.query(
    'SELECT status FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (ws.rows.length === 0)
    return err(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');
  if (ws.rows[0].status === 'investigating')
    return err(409, 'RUN_IN_PROGRESS', 'Cannot add documents while an investigation is running.');

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return err(400, 'INVALID_FORM', 'Could not parse multipart form data.');
  }

  const files = formData.getAll('files') as File[];
  const fileError = validateFiles(files);
  if (fileError) return fileError;

  const before = await pool.query<{ count: string }>(
    'SELECT count(*)::text FROM chunks WHERE workspace_id = $1',
    [workspaceId],
  );

  try {
    const { chunkCount } = await ingestFiles(files, workspaceId);
    return NextResponse.json({
      addedDocuments: files.length,
      addedChunks:    chunkCount,
      totalChunks:    parseInt(before.rows[0].count) + chunkCount,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('[POST /api/workspaces/[id]/upload]', e);
    return err(500, 'INGESTION_FAILED', message);
  }
}

