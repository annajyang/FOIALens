import Anthropic from '@anthropic-ai/sdk';
import pool from '@/lib/db/client';
import type { EntityEntry, EntityType } from '@/lib/types';
import { extractText, parseJSON } from './haiku-utils';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HAIKU = 'claude-haiku-4-5-20251001';
const MAX_CHUNKS = 20;

export type EntityScope = string;  // 'full' or a document ID

type ExtractedEntity = Omit<EntityEntry, 'firstSeenRunId'>;

export async function extractEntities(
  scope: EntityScope,
  workspaceId: string,
  knownNames: Set<string> = new Set(),
): Promise<{ entities: ExtractedEntity[]; newCount: number }> {
  const chunks = await fetchChunks(scope, workspaceId);
  if (chunks.length === 0) return { entities: [], newCount: 0 };

  const context = chunks
    .map(c => `[p.${c.start_page}] ${c.content}`)
    .join('\n\n---\n\n');

  const response = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 2048,
    system:
      'You are a precise information extraction system. ' +
      'Return ONLY valid JSON with no prose, preamble, or markdown fences.',
    messages: [
      {
        role: 'user',
        content: `Extract every named entity from the document text below.

Return a JSON array where each element has exactly these fields:
- "name": entity name (string)
- "type": one of "person" | "organization" | "date" | "amount" | "location"
- "mentions": approximate count of times mentioned (number)
- "pageRefs": page numbers where found (number[])
- "representativeContext": one sentence showing the entity in context (string)

Document text:
${context}

Return ONLY the JSON array.`,
      },
    ],
  });

  const text = extractText(response);
  const parsed = parseJSON<ExtractedEntity[]>(text);
  if (!parsed || !Array.isArray(parsed)) return { entities: [], newCount: 0 };

  const entities = parsed.filter(isValidEntity);
  const newCount = entities.filter(
    e => !knownNames.has(e.name.toLowerCase()),
  ).length;

  return { entities, newCount };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchChunks(scope: EntityScope, workspaceId: string) {
  if (scope === 'full') {
    const { rows } = await pool.query<{ content: string; start_page: number }>(
      `SELECT content, start_page FROM chunks
       WHERE workspace_id = $1
       ORDER BY document_id, chunk_index
       LIMIT $2`,
      [workspaceId, MAX_CHUNKS],
    );
    return rows;
  }

  // scope is a document ID
  const { rows } = await pool.query<{ content: string; start_page: number }>(
    `SELECT content, start_page FROM chunks
     WHERE workspace_id = $1 AND document_id = $2
     ORDER BY chunk_index
     LIMIT $3`,
    [workspaceId, scope, MAX_CHUNKS],
  );
  return rows;
}

const VALID_TYPES = new Set<EntityType>([
  'person', 'organization', 'date', 'amount', 'location',
]);

function isValidEntity(e: unknown): e is ExtractedEntity {
  if (!e || typeof e !== 'object') return false;
  const obj = e as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    VALID_TYPES.has(obj.type as EntityType) &&
    typeof obj.mentions === 'number' &&
    Array.isArray(obj.pageRefs) &&
    typeof obj.representativeContext === 'string'
  );
}
