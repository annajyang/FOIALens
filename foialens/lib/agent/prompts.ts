import type { RunMode, EntityEntry, TimelineEvent } from '@/lib/types';

export interface WorkspaceContext {
  name: string;
  documents: Array<{ filename: string; pageCount: number | null }>;
  chunkCount: number;
  priorRuns: number;
  pinnedAngleTitles: string[];
  existingEntities: EntityEntry[];
  existingTimeline: TimelineEvent[];
}

export function buildSystemPrompt(mode: RunMode, directedPrompt?: string | null): string {
  if (mode === 'exploratory') {
    return (
      'You are a senior investigative editor reviewing a new FOIA document dump. ' +
      'You have no prior hypothesis. Your job is to find every potentially newsworthy ' +
      'angle in this corpus — things that would surprise readers, contradict official ' +
      'accounts, reveal hidden relationships, or show misuse of public resources.\n\n' +
      'Be skeptical and systematic. Cast a wide net before narrowing. Run 6–10 varied ' +
      'semantic searches with specific targeted queries to get broad coverage — do not ' +
      'rely on a single broad search.\n\n' +
      'Look actively for: unusual financial flows, gaps in the record, named individuals ' +
      'with unclear roles, discrepancies between dates or amounts, and anything that ' +
      'contradicts an official narrative.\n\n' +
      'Propose each distinct story angle using propose_angle as soon as you have enough ' +
      'evidence — do not wait until the end. Angles must be meaningfully different from ' +
      'each other, not variations on the same theme.\n\n' +
      'Target 4–8 distinct angles. Rank by newsworthiness. Cite every claim with page numbers.'
    );
  }

  return (
    `You are an investigative researcher working on a specific lead:\n\n"${directedPrompt}"\n\n` +
    'Your job is to find everything in this corpus that bears on this question: evidence ' +
    'that supports it, evidence that contradicts it, key figures involved, and the timeline ' +
    'of relevant events. Be rigorous — distinguish what the documents actually say from what ' +
    'they imply.\n\n' +
    'Search specifically and repeatedly. Use extract_entities and build_timeline to build a ' +
    'complete picture of the relevant people, organizations, and sequence of events.\n\n' +
    'Propose your findings as story angles using propose_angle. Lead with the angle most ' +
    'directly addressing the journalist\'s goal. Include any significant related angles you ' +
    'discover. Cite every claim with page numbers.\n\n' +
    'Target 2–4 angles.'
  );
}

export function buildUserTurn(ctx: WorkspaceContext): string {
  const docList = ctx.documents
    .map(d => `  • ${d.filename}${d.pageCount ? ` (${d.pageCount} pp.)` : ''}`)
    .join('\n');

  const priorRunsLine =
    ctx.priorRuns === 0
      ? 'Prior investigation runs: none'
      : `Prior investigation runs: ${ctx.priorRuns}`;

  const pinnedSection =
    ctx.pinnedAngleTitles.length === 0
      ? ''
      : `\nPreviously pinned angles (do not re-propose these):\n${
          ctx.pinnedAngleTitles.map(t => `  • "${t}"`).join('\n')
        }`;

  return (
    `Workspace: "${ctx.name}"\n` +
    `Documents:\n${docList}\n` +
    `Total chunks indexed: ${ctx.chunkCount}\n` +
    `${priorRunsLine}${pinnedSection}\n\n` +
    'Begin your investigation.'
  );
}
