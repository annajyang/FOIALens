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
    await pool().execute("""
        ALTER TABLE workspaces
            ADD COLUMN IF NOT EXISTS guest_token UUID,
            ADD COLUMN IF NOT EXISTS owner_email  TEXT,
            ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days');
        CREATE INDEX IF NOT EXISTS idx_workspaces_guest_token ON workspaces(guest_token);
        CREATE INDEX IF NOT EXISTS idx_workspaces_owner_email ON workspaces(owner_email);
    """)


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
