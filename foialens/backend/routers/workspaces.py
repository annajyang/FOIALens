import asyncio

import asyncpg
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from db.client import pool
from ingestion.upload import create_workspace_and_ingest, ingest_files

router = APIRouter()

MAX_FILES = 20
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


class RenameRequest(BaseModel):
    name: str


@router.get("/workspaces")
async def list_workspaces():
    rows = await pool().fetch("""
        SELECT
            w.id, w.name, w.status, w.created_at,
            COUNT(DISTINCT d.id)::int  AS document_count,
            COUNT(DISTINCT a.id)::int  AS angle_count,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'pinned')::int AS pinned_count,
            MAX(r.completed_at) AS last_run_at
        FROM workspaces w
        LEFT JOIN documents d ON d.workspace_id = w.id
        LEFT JOIN angles a ON a.workspace_id = w.id
        LEFT JOIN investigation_runs r ON r.workspace_id = w.id AND r.status = 'done'
        GROUP BY w.id
        ORDER BY w.created_at DESC
    """)
    return {
        "workspaces": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "status": r["status"],
                "documentCount": r["document_count"],
                "angleCount": r["angle_count"],
                "pinnedCount": r["pinned_count"],
                "lastRunAt": r["last_run_at"].isoformat() if r["last_run_at"] else None,
                "createdAt": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/workspaces/{workspace_id}")
async def get_workspace(workspace_id: str):
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")

    docs, chunk_count, angles, runs = await asyncio.gather(
        pool().fetch(
            "SELECT id, filename, page_count, byte_size FROM documents WHERE workspace_id = $1 ORDER BY created_at",
            workspace_id,
        ),
        pool().fetchval("SELECT count(*)::int FROM chunks WHERE workspace_id = $1", workspace_id),
        pool().fetch("SELECT * FROM angles WHERE workspace_id = $1 ORDER BY created_at DESC", workspace_id),
        pool().fetch(
            "SELECT id, mode, prompt, status, started_at, completed_at "
            "FROM investigation_runs WHERE workspace_id = $1 ORDER BY started_at DESC",
            workspace_id,
        ),
    )

    return {
        "workspace": {
            "id": str(ws["id"]),
            "name": ws["name"],
            "status": ws["status"],
            "documents": [
                {
                    "id": str(d["id"]),
                    "filename": d["filename"],
                    "pageCount": d["page_count"],
                    "byteSize": d["byte_size"],
                }
                for d in docs
            ],
            "chunkCount": chunk_count,
            "angles": [_fmt_angle(a) for a in angles],
            "entities": ws["entities"] or [],
            "timeline": ws["timeline"] or [],
            "runs": [
                {
                    "id": str(r["id"]),
                    "mode": r["mode"],
                    "prompt": r["prompt"],
                    "status": r["status"],
                    "startedAt": r["started_at"].isoformat(),
                    "completedAt": r["completed_at"].isoformat() if r["completed_at"] else None,
                }
                for r in runs
            ],
            "createdAt": ws["created_at"].isoformat(),
            "updatedAt": ws["updated_at"].isoformat(),
        }
    }


@router.patch("/workspaces/{workspace_id}")
async def rename_workspace(workspace_id: str, body: RenameRequest):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty.")
    try:
        row = await pool().fetchrow(
            "UPDATE workspaces SET name = $1 WHERE id = $2 RETURNING id, name",
            name, workspace_id,
        )
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not row:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    return {"id": str(row["id"]), "name": row["name"]}


@router.post("/workspaces", status_code=201)
async def create_workspace(
    name: str = Form(...),
    files: list[UploadFile] = File(...),
):
    _validate_files(files)
    try:
        result = await create_workspace_and_ingest(name, files)
        return {"workspaceId": result["workspaceId"], "status": "ready",
                "documentCount": result["documentCount"], "chunkCount": result["chunkCount"]}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/workspaces/{workspace_id}/upload")
async def upload_to_workspace(
    workspace_id: str,
    files: list[UploadFile] = File(...),
):
    try:
        ws = await pool().fetchrow("SELECT status FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if ws["status"] == "investigating":
        raise HTTPException(status_code=409, detail="Cannot add documents while an investigation is running.")

    _validate_files(files)

    before = await pool().fetchval("SELECT count(*)::int FROM chunks WHERE workspace_id = $1", workspace_id)

    try:
        result = await ingest_files(files, workspace_id)
        return {
            "addedDocuments": result["documentCount"],
            "addedChunks":    result["chunkCount"],
            "totalChunks":    before + result["chunkCount"],
        }
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _validate_files(files: list[UploadFile]) -> None:
    if not files:
        raise HTTPException(status_code=400, detail="At least one PDF file is required.")
    if len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Maximum {MAX_FILES} files per upload.")
    for f in files:
        if f.size and f.size > MAX_FILE_SIZE:
            raise HTTPException(status_code=400, detail=f"{f.filename} exceeds the 50 MB limit.")
        if not (f.filename or "").lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"{f.filename} is not a PDF.")


def _fmt_angle(a) -> dict:
    return {
        "id":             str(a["id"]),
        "workspaceId":    str(a["workspace_id"]),
        "runId":          str(a["run_id"]),
        "title":          a["title"],
        "summary":        a["summary"],
        "newsworthiness": a["newsworthiness"],
        "angleType":      a["angle_type"],
        "evidence":       a["evidence"] or [],
        "citations":      a["citations"] or [],
        "status":         a["status"],
        "createdAt":      a["created_at"].isoformat(),
        "updatedAt":      a["updated_at"].isoformat(),
    }
