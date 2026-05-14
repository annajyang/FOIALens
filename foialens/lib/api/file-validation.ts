import { NextResponse } from 'next/server';

export const MAX_FILES     = 20;
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export function validateFiles(files: File[]): NextResponse | null {
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

export function err(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: code, message }, { status });
}
