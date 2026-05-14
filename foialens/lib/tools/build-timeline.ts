import Anthropic from '@anthropic-ai/sdk';
import { searchDocuments } from './search-documents';
import { extractText, parseJSON } from './haiku-utils';
import type { TimelineEvent } from '@/lib/types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HAIKU = 'claude-haiku-4-5-20251001';

// Queries that surface date-bearing language in FOIA-style documents.
const TIMELINE_QUERIES = [
  'signed dated effective agreement',
  'approved authorized ordered decision',
  'meeting minutes conference call scheduled',
  'announced commenced expired deadline',
  'awarded contract began terminated',
];

type ExtractedEvent = Omit<TimelineEvent, 'firstSeenRunId'>;

export async function buildTimeline(
  workspaceId: string,
): Promise<{ events: ExtractedEvent[] }> {
  const chunks = await gatherChunks(workspaceId);
  if (chunks.length === 0) return { events: [] };

  const context = chunks
    .map(c => `[p.${c.startPage}] ${c.content}`)
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
        content: `Extract every dated event from the document text below.
Only include events that have a specific or approximate date attached.

Return a JSON array where each element has exactly these fields:
- "date": ISO 8601 string (e.g. "2021-03-15") or "circa YYYY" for approximations (string)
- "description": what happened (string)
- "significance": why this event matters to an investigation (string)
- "pageRefs": page numbers where this event appears (number[])
- "confidence": "high" if date is explicit, "medium" if inferred, "low" if approximate (string)

Document text:
${context}

Return ONLY the JSON array.`,
      },
    ],
  });

  const text = extractText(response);
  const parsed = parseJSON<ExtractedEvent[]>(text);
  if (!parsed || !Array.isArray(parsed)) return { events: [] };

  const events = parsed.filter(isValidEvent);
  events.sort(chronologically);

  return { events };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gatherChunks(workspaceId: string) {
  const seen = new Set<string>();
  const chunks: { chunkId: string; content: string; startPage: number }[] = [];

  for (const query of TIMELINE_QUERIES) {
    const { results } = await searchDocuments(query, workspaceId, 5);
    for (const r of results) {
      if (!seen.has(r.chunkId)) {
        seen.add(r.chunkId);
        chunks.push({ chunkId: r.chunkId, content: r.content, startPage: r.startPage });
      }
    }
  }

  return chunks;
}

function isValidEvent(e: unknown): e is ExtractedEvent {
  if (!e || typeof e !== 'object') return false;
  const obj = e as Record<string, unknown>;
  return (
    typeof obj.date === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.significance === 'string' &&
    Array.isArray(obj.pageRefs) &&
    ['high', 'medium', 'low'].includes(obj.confidence as string)
  );
}

function chronologically(a: ExtractedEvent, b: ExtractedEvent): number {
  const aApprox = a.date.startsWith('circa');
  const bApprox = b.date.startsWith('circa');
  if (aApprox && !bApprox) return 1;
  if (!aApprox && bApprox) return -1;
  return a.date.localeCompare(b.date);
}
