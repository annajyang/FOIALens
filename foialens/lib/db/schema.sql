-- FOIALens database schema
-- Run once: psql foialens < lib/db/schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────
-- workspaces
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ingesting',
  entities    JSONB NOT NULL DEFAULT '[]',
  timeline    JSONB NOT NULL DEFAULT '[]',
  guest_token UUID,
  owner_email TEXT,
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_guest_token ON workspaces(guest_token);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_email ON workspaces(owner_email);

-- ─────────────────────────────────────────
-- documents
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  page_count   INTEGER,
  byte_size    INTEGER,
  file_key     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);

-- ─────────────────────────────────────────
-- chunks
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
  embedding    vector(1024),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chunks_document  ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─────────────────────────────────────────
-- investigation_runs
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investigation_runs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL,
  prompt       TEXT,
  status       TEXT NOT NULL DEFAULT 'investigating',
  summary      TEXT,
  trace        JSONB NOT NULL DEFAULT '[]',
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace ON investigation_runs(workspace_id);

-- ─────────────────────────────────────────
-- angles
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS angles (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         UUID NOT NULL REFERENCES investigation_runs(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  newsworthiness TEXT NOT NULL,
  angle_type     TEXT NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '[]',
  citations      JSONB NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'proposed',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_angles_workspace ON angles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_angles_run       ON angles(run_id);
CREATE INDEX IF NOT EXISTS idx_angles_status    ON angles(workspace_id, status);

-- ─────────────────────────────────────────
-- updated_at trigger
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
