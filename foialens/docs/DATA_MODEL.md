# FOIALens — Data Model

## PostgreSQL schema

```sql
-- schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────
-- workspaces
-- Top-level entity. One workspace = one document corpus + ongoing investigation.
-- A journalist creates one workspace per story, runs N investigations against it.
-- ─────────────────────────────────────────
CREATE TABLE workspaces (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,                  -- journalist-editable, e.g. "City Hall 2023"
  status          TEXT NOT NULL DEFAULT 'ingesting',
                                                  -- ingesting | ready | investigating | active
  -- Accumulated entity map and timeline across all runs (merged, deduplicated)
  entities        JSONB NOT NULL DEFAULT '[]',
  timeline        JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- documents
-- One row per uploaded PDF, linked to a workspace.
-- ─────────────────────────────────────────
CREATE TABLE documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  page_count   INTEGER,
  byte_size    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_workspace ON documents(workspace_id);

-- ─────────────────────────────────────────
-- chunks
-- One row per text chunk. Embedding used for semantic search.
-- ─────────────────────────────────────────
CREATE TABLE chunks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  start_page   INTEGER NOT NULL,
  end_page     INTEGER NOT NULL,
  chunk_index  INTEGER NOT NULL,       -- ordinal within the document
  token_count  INTEGER,                -- approximate
  embedding    vector(1536),           -- text-embedding-3-small
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chunks_workspace  ON chunks(workspace_id);
CREATE INDEX idx_chunks_document   ON chunks(document_id);
-- IVFFlat for approximate nearest-neighbor. lists=100 suits corpora up to ~1M chunks.
CREATE INDEX idx_chunks_embedding  ON chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─────────────────────────────────────────
-- investigation_runs
-- One row per agent invocation. A workspace can have many runs.
-- Each run has a mode and optional focus prompt.
-- ─────────────────────────────────────────
CREATE TABLE investigation_runs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL,          -- 'exploratory' | 'directed'
  prompt       TEXT,                   -- null for exploratory runs
  status       TEXT NOT NULL DEFAULT 'investigating',
                                       -- investigating | done | error
  summary      TEXT,                   -- agent's final free-text memo
  trace        JSONB NOT NULL DEFAULT '[]',  -- ordered list of TraceEntry
  error        TEXT,                   -- set on failure
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_runs_workspace ON investigation_runs(workspace_id);

-- ─────────────────────────────────────────
-- angles
-- One row per story angle proposed by the agent.
-- Angles accumulate across runs. Journalist triages each one.
-- ─────────────────────────────────────────
CREATE TABLE angles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES investigation_runs(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,          -- working headline
  summary         TEXT NOT NULL,          -- 2–3 sentence newsworthiness description
  newsworthiness  TEXT NOT NULL,          -- 'high' | 'medium' | 'low'
  angle_type      TEXT NOT NULL,          -- see AngleType below
  evidence        JSONB NOT NULL,         -- string[] of key facts with inline citations
  citations       JSONB NOT NULL,         -- Array<{ page, excerpt }>
  status          TEXT NOT NULL DEFAULT 'proposed',
                                          -- 'proposed' | 'pinned' | 'dismissed'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_angles_workspace ON angles(workspace_id);
CREATE INDEX idx_angles_run       ON angles(run_id);
CREATE INDEX idx_angles_status    ON angles(workspace_id, status);
```

---

## Entity-relationship diagram

```
workspaces
  │
  ├──< documents ──< chunks (embedding vector)
  │
  ├──< investigation_runs
  │         │
  │         └──< angles
  │
  ├── entities (JSONB, accumulated across runs)
  └── timeline (JSONB, accumulated across runs)
```

---

## Workspace status lifecycle

```
ingesting
  │  (all documents extracted, chunked, embedded, stored)
  ▼
ready
  │  (POST /api/investigate — first run starts)
  ▼
investigating
  │
  ├──▶  active     (run finished, at least one angle proposed)
  │       │
  │       └──▶  investigating  (journalist triggers another run)
  │
  └──▶  ready      (run finished but no angles proposed — edge case)
```

`active` is the steady state for a workspace that has had at least one successful run. The workspace stays `active` indefinitely; journalists return to it and add runs.

---

## Investigation run status lifecycle

```
investigating  →  done   (agent finished, angles saved, summary written)
             ↘  error  (agent or DB failure)
```

---

## JSONB structures

### `workspaces.entities` — accumulated entity map

Grows across all runs. New entities from each run are merged in (matched by normalized name).

```ts
type EntityMap = Array<{
  name: string;
  type: "person" | "organization" | "date" | "amount" | "location";
  mentions: number;
  pageRefs: number[];                  // deduplicated, ascending
  representativeContext: string;
  firstSeenRunId: string;
}>;
```

### `workspaces.timeline` — accumulated timeline

```ts
type Timeline = Array<{
  date: string;                        // ISO 8601 or "circa YYYY"
  description: string;
  significance: string;
  pageRefs: number[];
  confidence: "high" | "medium" | "low";
  firstSeenRunId: string;
}>;
```

### `investigation_runs.trace` — ordered agent reasoning trace

```ts
type Trace = Array<{
  type: "tool_call" | "tool_result" | "final";
  tool?: string;
  input?: Record<string, unknown>;
  resultSummary?: string;
  content?: string;                    // for "final" type
  timestamp: string;
}>;
```

### `angles.evidence`

```ts
type Evidence = string[];   // e.g. ["Mayor approved $2.3M payment (p.14)", ...]
```

### `angles.citations`

```ts
type Citations = Array<{
  page: number;
  excerpt: string;          // verbatim text from the document
}>;
```

---

## TypeScript types (`lib/types.ts`)

```ts
export type WorkspaceStatus = "ingesting" | "ready" | "investigating" | "active";
export type RunStatus       = "investigating" | "done" | "error";
export type AngleStatus     = "proposed" | "pinned" | "dismissed";
export type Newsworthiness  = "high" | "medium" | "low";
export type AngleType =
  | "financial"     // unusual payments, budget anomalies
  | "personnel"     // individuals with unexpected roles or conflicts
  | "timeline"      // when things happened, delays, retroactive decisions
  | "contradiction" // documents contradict each other or official statements
  | "omission"      // something conspicuously absent from the record
  | "relationship"  // connections between people, orgs, contracts
  | "other";

export interface Workspace {
  id: string;
  name: string;
  status: WorkspaceStatus;
  entities: EntityMap;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  workspaceId: string;
  filename: string;
  pageCount: number | null;
  byteSize: number | null;
  createdAt: string;
}

export interface InvestigationRun {
  id: string;
  workspaceId: string;
  mode: "exploratory" | "directed";
  prompt: string | null;
  status: RunStatus;
  summary: string | null;
  trace: TraceEntry[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

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

export interface TraceEntry {
  type: "tool_call" | "tool_result" | "final";
  tool?: string;
  input?: Record<string, unknown>;
  resultSummary?: string;
  content?: string;
  timestamp: string;
}

export interface EntityEntry {
  name: string;
  type: "person" | "organization" | "date" | "amount" | "location";
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
  confidence: "high" | "medium" | "low";
  firstSeenRunId: string;
}

export type EntityMap    = EntityEntry[];
export type TimelineData = TimelineEvent[];
```

---

## Design notes

- **Angles in a normalized table, not JSONB** — Unlike entities and timeline (which are aggregated blobs), angles are objects the journalist directly interacts with: they are triaged, pinned, dismissed. Normalized rows make this cheap (`UPDATE angles SET status = 'pinned' WHERE id = $1`) and queryable by status.
- **Entities and timeline as JSONB on the workspace** — These accumulate by merging across runs. They are always read whole, never filtered by individual entry, so JSONB is simpler than a normalized table. If entity-level search becomes a feature, migrate to a normalized table at that point.
- **Cascading deletes** — Deleting a workspace cascades through documents → chunks, runs → angles. One delete cleans everything.
- **No soft deletes** — Dismissed angles are kept (status = 'dismissed') so the journalist has a record of what was considered and rejected. Hard deletion is not exposed in the UI.
- **pgvector dimension** — 1536 matches `text-embedding-3-small`. Changing the model requires dropping and recreating the `embedding` column and re-ingesting all documents.
- **IVFFlat vs. HNSW** — IVFFlat is used for lower build cost. Switch to HNSW if query latency degrades at scale (> 1M chunks).
