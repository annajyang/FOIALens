import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { searchDocuments } from './search-documents';
import { extractEntities } from './extract-entities';
import { buildTimeline } from './build-timeline';
import { proposeAngle, type ProposeAngleInput } from './propose-angle';

// ── Tool definitions (passed to Claude API) ───────────────────────────────────

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'search_documents',
    description:
      'Semantic search over document chunks in the workspace. ' +
      'Run multiple targeted searches with specific queries rather than one broad search. ' +
      'Returns the most relevant chunks with page numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Specific search query — more targeted queries return better results',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'extract_entities',
    description:
      'Extract named entities — people, organizations, dates, dollar amounts, locations — ' +
      'from the document corpus or a specific document.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          description:
            "Pass \"full\" to extract from the entire workspace corpus, " +
            "or a document ID to limit to one document.",
        },
      },
      required: [],
    },
  },
  {
    name: 'build_timeline',
    description:
      'Reconstruct a chronological timeline of events from dated references across the documents. ' +
      'Returns events sorted oldest-first with confidence ratings.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'propose_angle',
    description:
      'Propose a story angle you have found evidence for. ' +
      'Call this as soon as you have enough evidence to support a distinct, newsworthy angle — ' +
      'do not wait until the end. Each call creates an angle card visible to the journalist in real time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Working headline, approximately 8 words',
        },
        summary: {
          type: 'string',
          description: '2–3 sentence explanation of why this is newsworthy',
        },
        newsworthiness: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
        },
        angleType: {
          type: 'string',
          enum: ['financial', 'personnel', 'timeline', 'contradiction', 'omission', 'relationship', 'other'],
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key supporting facts with inline (p. N) citations',
        },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              page:    { type: 'number' },
              excerpt: { type: 'string', description: 'Verbatim text from the document' },
            },
            required: ['page', 'excerpt'],
          },
        },
      },
      required: ['title', 'summary', 'newsworthiness', 'angleType', 'evidence', 'citations'],
    },
  },
];

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  workspaceId: string,
  runId: string,
  knownEntityNames: Set<string> = new Set(),
): Promise<unknown> {
  switch (name) {
    case 'search_documents':
      return searchDocuments(
        input.query as string,
        workspaceId,
        (input.limit as number | undefined) ?? 10,
      );

    case 'extract_entities':
      return extractEntities(
        (input.scope as string | undefined) ?? 'full',
        workspaceId,
        knownEntityNames,
      );

    case 'build_timeline':
      return buildTimeline(workspaceId);

    case 'propose_angle':
      return proposeAngle(input as unknown as ProposeAngleInput, workspaceId, runId);

    default:
      throw new Error(`Unknown tool: "${name}"`);
  }
}
