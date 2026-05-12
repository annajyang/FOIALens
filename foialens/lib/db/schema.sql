-- FOIALens database schema
-- Run once: psql foialens < lib/db/schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────
-- workspaces
-- One per investigation. Accumulates entities and timeline across all runs.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ingesting',
             -- ingesting | ready | investigating | active
  entities   JSONB NOT NULL DEFAULT '[]',
  timeline   JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- documents
-- One row per uploaded PDF.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  page_count   INTEGER,
  byte_size    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);

-- ─────────────────────────────────────────
-- chunks
-- One row per text chunk. embedding is the pgvector column.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  start_page   INTEGER NOT NULL,
  end_page     INTEGER NOT NULL,
  chunk_index  INTEGER NOT NULL,
  token_count  INTEGER,
  embedding    vector(1536),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chunks_document  ON chunks(document_id);
-- Build this index after bulk inserts, not before.
-- lists=100 suits corpora up to ~1M chunks; raise if needed.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─────────────────────────────────────────
-- investigation_runs
-- One per agent invocation. A workspace can have many.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investigation_runs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL,   -- exploratory | directed
  prompt       TEXT,
  status       TEXT NOT NULL DEFAULT 'investigating',
               -- investigating | done | error
  summary      TEXT,
  trace        JSONB NOT NULL DEFAULT '[]',
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace ON investigation_runs(workspace_id);

-- ─────────────────────────────────────────
-- angles
-- One per story angle proposed by the agent.
-- Journalist triages each one (proposed → pinned | dismissed).
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS angles (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         UUID NOT NULL REFERENCES investigation_runs(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  newsworthiness TEXT NOT NULL,  -- high | medium | low
  angle_type     TEXT NOT NULL,  -- financial | personnel | timeline | contradiction | omission | relationship | other
  evidence       JSONB NOT NULL DEFAULT '[]',
  citations      JSONB NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'proposed',
                 -- proposed | pinned | dismissed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_angles_workspace ON angles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_angles_run       ON angles(run_id);
CREATE INDEX IF NOT EXISTS idx_angles_status    ON angles(workspace_id, status);

-- ─────────────────────────────────────────
-- updated_at trigger (workspaces + angles)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER angles_updated_at
  BEFORE UPDATE ON angles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
