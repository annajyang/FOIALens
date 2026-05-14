import Anthropic from '@anthropic-ai/sdk';
import pool from '@/lib/db/client';
import { TOOL_DEFINITIONS, dispatchTool } from '@/lib/tools';
import { buildSystemPrompt, buildUserTurn, type WorkspaceContext } from './prompts';
import type {
  SSEEvent, Angle, EntityEntry, TimelineEvent,
  RunMode, TraceEntry, AngleStatus, Newsworthiness, AngleType, Citation,
} from '@/lib/types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SONNET = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 30;

export interface InvestigationParams {
  workspaceId: string;
  runId: string;
  mode: RunMode;
  prompt: string | null;
  workspaceContext: WorkspaceContext;
}

type ExtractedEntity = Omit<EntityEntry, 'firstSeenRunId'>;
type ExtractedEvent  = Omit<TimelineEvent, 'firstSeenRunId'>;

export async function runInvestigation(
  params: InvestigationParams,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const { workspaceId, runId, mode, prompt, workspaceContext } = params;

  await pool.query(
    `UPDATE workspaces SET status = 'investigating', updated_at = NOW() WHERE id = $1`,
    [workspaceId],
  );

  onEvent({
    type: 'status',
    message: mode === 'exploratory' ? 'Starting exploratory scan…' : 'Starting directed investigation…',
  });

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildUserTurn(workspaceContext) },
  ];

  const knownEntityNames = new Set<string>(
    workspaceContext.existingEntities.map(e => e.name.toLowerCase()),
  );

  const trace: TraceEntry[] = [];
  let accEntities: ExtractedEntity[] = [];
  let accEvents: ExtractedEvent[] = [];
  let angleCount = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: SONNET,
        max_tokens: 8192,
        system: buildSystemPrompt(mode, prompt),
        tools: TOOL_DEFINITIONS,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
        const finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();

        trace.push({ type: 'final', content: finalText, timestamp: new Date().toISOString() });

        const { newEntityCount, newEventCount } = await mergeIntoWorkspace(
          workspaceId, runId, accEntities, accEvents, workspaceContext,
        );

        await pool.query(
          `UPDATE investigation_runs
           SET status = 'done', summary = $1, trace = $2::jsonb, completed_at = NOW()
           WHERE id = $3`,
          [finalText || null, JSON.stringify(trace), runId],
        );
        await pool.query(
          `UPDATE workspaces SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [workspaceId],
        );

        onEvent({
          type: 'done',
          runId,
          summary: finalText,
          angleCount,
          newEntityCount,
          newTimelineEventCount: newEventCount,
        });
        return;
      }

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of toolBlocks) {
          onEvent({ type: 'status', message: `Calling ${block.name}…` });

          const result = await dispatchTool(
            block.name,
            block.input as Record<string, unknown>,
            workspaceId,
            runId,
            knownEntityNames,
          );

          if (block.name === 'extract_entities') {
            const extracted = (result as { entities: ExtractedEntity[] }).entities;
            for (const e of extracted) knownEntityNames.add(e.name.toLowerCase());
            accEntities = mergeEntities(accEntities, extracted);
          }

          if (block.name === 'build_timeline') {
            const extracted = (result as { events: ExtractedEvent[] }).events;
            accEvents = mergeEvents(accEvents, extracted);
          }

          if (block.name === 'propose_angle') {
            const { angleId } = result as { angleId: string };
            const angle = await fetchAngle(angleId);
            if (angle) {
              onEvent({ type: 'angle_proposed', angle });
              angleCount++;
            }
          }

          const timestamp = new Date().toISOString();
          const resultSummary = summarizeResult(block.name, result);
          const input = block.input as Record<string, unknown>;

          onEvent({ type: 'trace', tool: block.name, input, resultSummary, timestamp });
          trace.push({ type: 'tool_call', tool: block.name, input, resultSummary, timestamp });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }
    }

    throw new Error('Investigation exceeded the maximum iteration limit.');

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await Promise.allSettled([
      pool.query(
        `UPDATE investigation_runs
         SET status = 'error', error = $1, trace = $2::jsonb, completed_at = NOW()
         WHERE id = $3`,
        [message, JSON.stringify(trace), runId],
      ),
      pool.query(
        `UPDATE workspaces SET status = 'active', updated_at = NOW() WHERE id = $1`,
        [workspaceId],
      ),
    ]);
    onEvent({ type: 'error', message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchAngle(angleId: string): Promise<Angle | null> {
  const { rows } = await pool.query<{
    id: string; workspace_id: string; run_id: string; title: string; summary: string;
    newsworthiness: Newsworthiness; angle_type: AngleType; evidence: string[];
    citations: Citation[]; status: AngleStatus; created_at: string; updated_at: string;
  }>('SELECT * FROM angles WHERE id = $1', [angleId]);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    runId: r.run_id,
    title: r.title,
    summary: r.summary,
    newsworthiness: r.newsworthiness,
    angleType: r.angle_type,
    evidence: r.evidence,
    citations: r.citations,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function mergeIntoWorkspace(
  workspaceId: string,
  runId: string,
  newEntities: ExtractedEntity[],
  newEvents: ExtractedEvent[],
  ctx: WorkspaceContext,
): Promise<{ newEntityCount: number; newEventCount: number }> {
  const existing = ctx.existingEntities;
  const existingTl = ctx.existingTimeline;

  const existingNames = new Set(existing.map(e => e.name.toLowerCase()));
  const existingKeys = new Set(existingTl.map(eventKey));

  const newEntityCount = newEntities.filter(e => !existingNames.has(e.name.toLowerCase())).length;
  const newEventCount  = newEvents.filter(e => !existingKeys.has(eventKey(e))).length;

  const entityByName = new Map(existing.map(e => [e.name.toLowerCase(), { ...e }]));
  for (const e of newEntities) {
    const key = e.name.toLowerCase();
    const found = entityByName.get(key);
    if (found) {
      found.mentions += e.mentions;
      for (const p of e.pageRefs) {
        if (!found.pageRefs.includes(p)) found.pageRefs.push(p);
      }
    } else {
      entityByName.set(key, { ...e, firstSeenRunId: runId });
    }
  }

  const mergedTimeline = [...existingTl];
  const seenKeys = new Set(existingTl.map(eventKey));
  for (const e of newEvents) {
    const k = eventKey(e);
    if (!seenKeys.has(k)) {
      seenKeys.add(k);
      mergedTimeline.push({ ...e, firstSeenRunId: runId });
    }
  }

  await pool.query(
    `UPDATE workspaces
     SET entities = $1::jsonb, timeline = $2::jsonb, updated_at = NOW()
     WHERE id = $3`,
    [
      JSON.stringify(Array.from(entityByName.values())),
      JSON.stringify(mergedTimeline),
      workspaceId,
    ],
  );

  return { newEntityCount, newEventCount };
}

function mergeEntities(existing: ExtractedEntity[], incoming: ExtractedEntity[]): ExtractedEntity[] {
  const byName = new Map(existing.map(e => [e.name.toLowerCase(), { ...e }]));
  for (const e of incoming) {
    const key = e.name.toLowerCase();
    const found = byName.get(key);
    if (found) {
      found.mentions += e.mentions;
      for (const p of e.pageRefs) {
        if (!found.pageRefs.includes(p)) found.pageRefs.push(p);
      }
    } else {
      byName.set(key, { ...e });
    }
  }
  return Array.from(byName.values());
}

function mergeEvents(existing: ExtractedEvent[], incoming: ExtractedEvent[]): ExtractedEvent[] {
  const seen = new Set(existing.map(eventKey));
  const result = [...existing];
  for (const e of incoming) {
    const k = eventKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(e);
    }
  }
  return result;
}

function eventKey(e: { date: string; description: string }): string {
  return `${e.date}|${e.description.slice(0, 80)}`;
}

function summarizeResult(toolName: string, result: unknown): string {
  switch (toolName) {
    case 'search_documents':
      return `Found ${(result as { results: unknown[] }).results.length} chunk(s)`;
    case 'extract_entities': {
      const r = result as { entities: unknown[]; newCount: number };
      return `Extracted ${r.entities.length} entities (${r.newCount} new)`;
    }
    case 'build_timeline':
      return `Found ${(result as { events: unknown[] }).events.length} dated event(s)`;
    case 'propose_angle':
      return `Angle proposed: ${(result as { angleId: string }).angleId}`;
    default:
      return JSON.stringify(result).slice(0, 120);
  }
}
