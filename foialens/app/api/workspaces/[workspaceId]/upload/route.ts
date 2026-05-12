import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db/client';
import { ingestFiles } from '@/lib/ingestion/upload';

export const maxDuration = 120;

const MAX_FILES     = 20;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

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

function validateFiles(files: File[]): NextResponse | null {
  if (files.length === 0)
    return err(400, 'NO_FILES', 'At least one PDF file is required.');
  if (files.length > MAX_FILES)
    return err(400, 'TOO_MANY_FILES', `Maximum ${MAX_FILES} files per upload.`);
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE)
      return err(400, 'FILE_TOO_LARGE', `${file.name} exceeds the 50 MB limit.`);
    if (!file.name.toLowerCase().endsWith('.pdf'))
      return err(400, 'INVALID_TYPE', `${file.name} is not a PDF.`);
  }
  return null;
}

function err(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: code, message }, { status });
}
