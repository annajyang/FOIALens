import { NextRequest } from 'next/server';
import pool from '@/lib/db/client';
import { runInvestigation } from '@/lib/agent/investigator';
import type { SSEEvent, RunMode, EntityEntry, TimelineEvent } from '@/lib/types';
import type { WorkspaceContext } from '@/lib/agent/prompts';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let body: { workspaceId?: string; mode?: string; prompt?: string };
  try {
    body = await request.json();
  } catch {
    return jsonErr(400, 'INVALID_BODY', 'Request body must be valid JSON.');
  }

  const { workspaceId, mode, prompt } = body;

  if (!workspaceId)
    return jsonErr(400, 'MISSING_WORKSPACE', 'workspaceId is required.');
  if (!mode || !['exploratory', 'directed'].includes(mode))
    return jsonErr(400, 'INVALID_MODE', 'mode must be "exploratory" or "directed".');
  if (mode === 'directed' && !prompt?.trim())
    return jsonErr(400, 'MISSING_PROMPT', 'A prompt is required for directed mode.');

  const wsResult = await pool.query<{
    name: string;
    status: string;
    entities: EntityEntry[];
    timeline: TimelineEvent[];
  }>(
    'SELECT name, status, entities, timeline FROM workspaces WHERE id = $1',
    [workspaceId],
  );

  if (wsResult.rows.length === 0)
    return jsonErr(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  const ws = wsResult.rows[0];
  if (ws.status === 'ingesting')
    return jsonErr(409, 'INGESTION_IN_PROGRESS', 'Document ingestion is still in progress.');
  if (ws.status === 'investigating')
    return jsonErr(409, 'RUN_IN_PROGRESS', 'Another investigation is already running.');

  const [docsResult, chunkResult, priorRunsResult, pinnedResult] = await Promise.all([
    pool.query<{ filename: string; page_count: number | null }>(
      'SELECT filename, page_count FROM documents WHERE workspace_id = $1 ORDER BY created_at',
      [workspaceId],
    ),
    pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chunks WHERE workspace_id = $1',
      [workspaceId],
    ),
    pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM investigation_runs
       WHERE workspace_id = $1 AND status = 'done'`,
      [workspaceId],
    ),
    pool.query<{ title: string }>(
      `SELECT title FROM angles WHERE workspace_id = $1 AND status = 'pinned'`,
      [workspaceId],
    ),
  ]);

  const workspaceContext: WorkspaceContext = {
    name: ws.name,
    documents: docsResult.rows.map(r => ({ filename: r.filename, pageCount: r.page_count })),
    chunkCount: chunkResult.rows[0].n,
    priorRuns: priorRunsResult.rows[0].n,
    pinnedAngleTitles: pinnedResult.rows.map(r => r.title),
    existingEntities: ws.entities ?? [],
    existingTimeline: ws.timeline ?? [],
  };

  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO investigation_runs (workspace_id, mode, prompt, status)
     VALUES ($1, $2, $3, 'investigating') RETURNING id`,
    [workspaceId, mode, prompt?.trim() ?? null],
  );
  const runId = runRows[0].id;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event: SSEEvent) => {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      try {
        await runInvestigation(
          {
            workspaceId,
            runId,
            mode: mode as RunMode,
            prompt: prompt?.trim() ?? null,
            workspaceContext,
          },
          enqueue,
        );
      } catch (err) {
        enqueue({
          type: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function jsonErr(status: number, code: string, message: string) {
  return Response.json({ error: code, message }, { status });
}
