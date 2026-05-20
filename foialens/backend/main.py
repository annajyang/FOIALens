import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv("../.env.local")

from db.client import init_pool, close_pool
from routers import workspaces, investigate, angles, runs


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

app.include_router(workspaces.router, prefix="/api")
app.include_router(investigate.router, prefix="/api")
app.include_router(angles.router, prefix="/api")
app.include_router(runs.router, prefix="/api")
