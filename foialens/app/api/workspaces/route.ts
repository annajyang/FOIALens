import { NextRequest, NextResponse } from 'next/server';
import { createWorkspaceAndIngest } from '@/lib/ingestion/upload';
import { validateFiles, err } from '@/lib/api/file-validation';

export const maxDuration = 120;

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

