// ── Workspace ────────────────────────────────────────────────────────────────

export type WorkspaceStatus = 'ingesting' | 'ready' | 'investigating' | 'active';

export interface Workspace {
  id: string;
  name: string;
  status: WorkspaceStatus;
  entities: EntityEntry[];
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
}

// ── Documents & Chunks ───────────────────────────────────────────────────────

export interface Document {
  id: string;
  workspaceId: string;
  filename: string;
  pageCount: number | null;
  byteSize: number | null;
  createdAt: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  workspaceId: string;
  content: string;
  startPage: number;
  endPage: number;
  chunkIndex: number;
  tokenCount: number | null;
}

// ── Investigation Runs ───────────────────────────────────────────────────────

export type RunMode   = 'exploratory' | 'directed';
export type RunStatus = 'investigating' | 'done' | 'error';

export interface InvestigationRun {
  id: string;
  workspaceId: string;
  mode: RunMode;
  prompt: string | null;
  status: RunStatus;
  summary: string | null;
  trace: TraceEntry[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface TraceEntry {
  type: 'tool_call' | 'final';
  tool?: string;
  input?: Record<string, unknown>;
  resultSummary?: string;
  content?: string;
  timestamp: string;
}

// ── Angles ───────────────────────────────────────────────────────────────────

export type AngleStatus    = 'proposed' | 'pinned' | 'dismissed';
export type Newsworthiness = 'high' | 'medium' | 'low';
export type AngleType =
  | 'financial'
  | 'personnel'
  | 'timeline'
  | 'contradiction'
  | 'omission'
  | 'relationship'
  | 'other';

export interface Angle {
  id: string;
  workspaceId: string;
  runId: string;
  title: string;
  summary: string;
  newsworthiness: Newsworthiness;
  angleType: AngleType;
  evidence: string[];
  citations: Citation[];
  status: AngleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Citation {
  page: number;
  excerpt: string;
}

// ── Entity map & Timeline ────────────────────────────────────────────────────

export type EntityType =
  | 'person'
  | 'organization'
  | 'date'
  | 'amount'
  | 'location';

export interface EntityEntry {
  name: string;
  type: EntityType;
  mentions: number;
  pageRefs: number[];
  representativeContext: string;
  firstSeenRunId: string;
}

export interface TimelineEvent {
  date: string;
  description: string;
  significance: string;
  pageRefs: number[];
  confidence: 'high' | 'medium' | 'low';
  firstSeenRunId: string;
}

// ── SSE events (investigate route ↔ client) ──────────────────────────────────

export type SSEEvent =
  | { type: 'status'; message: string }
  | {
      type: 'trace';
      tool: string;
      input: Record<string, unknown>;
      resultSummary: string;
      timestamp: string;
    }
  | { type: 'angle_proposed'; angle: Angle }
  | {
      type: 'done';
      runId: string;
      summary: string;
      angleCount: number;
      newEntityCount: number;
      newTimelineEventCount: number;
    }
  | { type: 'error'; message: string };

// ── API response shapes ───────────────────────────────────────────────────────

export interface WorkspaceListItem {
  id: string;
  name: string;
  status: WorkspaceStatus;
  documentCount: number;
  angleCount: number;
  pinnedCount: number;
  lastRunAt: string | null;
  createdAt: string;
  saved: boolean;
}

export interface WorkspaceDetail extends Workspace {
  documents: Document[];
  chunkCount: number;
  angles: Angle[];
  saved: boolean;
  ownerEmail: string | null;
  expiresAt: string | null;
  runs: Array<
    Pick<InvestigationRun, 'id' | 'mode' | 'prompt' | 'status' | 'startedAt' | 'completedAt'> & { trace: TraceEntry[] }
  >;
}
