import { NextRequest, NextResponse } from 'next/server';
import { createWorkspaceAndIngest } from '@/lib/ingestion/upload';

export const maxDuration = 120;

const MAX_FILES     = 20;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return err(400, 'INVALID_FORM', 'Could not parse multipart form data.');
  }

  const name = formData.get('name');
  if (!name || typeof name !== 'string' || !name.trim()) {
    return err(400, 'MISSING_NAME', 'Workspace name is required.');
  }

  const files = formData.getAll('files') as File[];
  const fileError = validateFiles(files);
  if (fileError) return fileError;

  try {
    const result = await createWorkspaceAndIngest(name, files);
    return NextResponse.json(
      {
        workspaceId:   result.workspaceId,
        status:        'ready',
        documentCount: result.documentCount,
        chunkCount:    result.chunkCount,
      },
      { status: 201 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('[POST /api/workspaces]', e);
    return err(500, 'INGESTION_FAILED', message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
