import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv("../.env.local")

from db.client import init_pool, close_pool
from routers import workspaces, investigate, angles, runs, auth


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    await _migrate()
    yield
    await close_pool()


async def _migrate():
    from db.client import pool
    from ingestion.embedder import embed_texts

    await pool().execute("""
        ALTER TABLE workspaces
            ADD COLUMN IF NOT EXISTS guest_token UUID,
            ADD COLUMN IF NOT EXISTS owner_email  TEXT,
            ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days');
        CREATE INDEX IF NOT EXISTS idx_workspaces_guest_token ON workspaces(guest_token);
        CREATE INDEX IF NOT EXISTS idx_workspaces_owner_email ON workspaces(owner_email);
        ALTER TABLE documents
            ADD COLUMN IF NOT EXISTS file_key TEXT;
    """)

    # GIN index for full-text keyword search (hybrid retrieval).
    # Runs once; IF NOT EXISTS makes it a no-op on subsequent startups.
    try:
        await pool().execute("""
            CREATE INDEX IF NOT EXISTS idx_chunks_content_fts
                ON chunks USING gin(to_tsvector('english', content));
        """)
    except Exception as e:
        print(f"[migrate] GIN index skipped: {e}", flush=True)

    # OTP auth tokens table for magic-link sign-in.
    try:
        await pool().execute("""
            CREATE TABLE IF NOT EXISTS auth_tokens (
                id          UUID        PRIMARY KEY,
                email       TEXT        NOT NULL,
                code_hash   TEXT        NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
                used_at     TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens(email);
        """)
    except Exception as e:
        print(f"[migrate] auth_tokens table skipped: {e}", flush=True)

    # OCR flag — marks chunks whose text came from vision-model transcription.
    try:
        await pool().execute("""
            ALTER TABLE chunks
                ADD COLUMN IF NOT EXISTS ocr_processed BOOLEAN NOT NULL DEFAULT FALSE;
        """)
    except Exception as e:
        print(f"[migrate] ocr_processed column skipped: {e}", flush=True)

    # Ensure the embedding column dimension matches the actual model output.
    try:
        test = await embed_texts(["ping"])
        dim = len(test[0])
        row = await pool().fetchrow(
            "SELECT atttypmod FROM pg_attribute "
            "WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'"
        )
        current_dim = row["atttypmod"] if row else None
        if current_dim != dim:
            print(f"[migrate] resizing embedding column {current_dim} → {dim}", flush=True)
            await pool().execute(f"""
                DROP INDEX IF EXISTS idx_chunks_embedding;
                ALTER TABLE chunks ALTER COLUMN embedding TYPE vector({dim});
                CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
                    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
            """)
    except Exception as e:
        print(f"[migrate] embedding dimension check skipped: {e}", flush=True)


app = FastAPI(title="FOIALens API", lifespan=lifespan)

_frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_frontend_url],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,       prefix="/api")
app.include_router(workspaces.router, prefix="/api")
app.include_router(investigate.router, prefix="/api")
app.include_router(angles.router,     prefix="/api")
app.include_router(runs.router,       prefix="/api")
