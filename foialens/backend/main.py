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
    yield
    await close_pool()


app = FastAPI(title="FOIALens API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(workspaces.router, prefix="/api")
app.include_router(investigate.router, prefix="/api")
app.include_router(angles.router, prefix="/api")
app.include_router(runs.router, prefix="/api")
