import asyncio
from typing import Annotated, Optional

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from auth_utils import decode_jwt
from db.client import pool
from ingestion.upload import create_workspace_and_ingest, ingest_files
from storage.spaces import presigned_url, delete_folder, delete_object

router = APIRouter()

MAX_FILES = 20
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


class RenameRequest(BaseModel):
    name: str


class ClaimRequest(BaseModel):
    email: str


def _get_session(
    x_guest_token: Optional[str] = Header(None),
    x_owner_email: Optional[str] = Header(None),
    x_auth_token: Optional[str] = Header(None),
) -> tuple[str | None, str | None]:
    """Resolve (guest_token, email). JWT in X-Auth-Token takes precedence."""
    if x_auth_token:
        email = decode_jwt(x_auth_token)
        if email:
            return None, email
    return x_guest_token or None, (x_owner_email or "").strip().lower() or None


Session = Annotated[tuple[str | None, str | None], Depends(_get_session)]


@router.get("/workspaces")
async def list_workspaces(session: Session):
    token, email = session
    rows = await pool().fetch("""
        SELECT
            w.id, w.name, w.status, w.created_at, w.owner_email, w.expires_at,
            COUNT(DISTINCT d.id)::int  AS document_count,
            COUNT(DISTINCT a.id)::int  AS angle_count,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'pinned')::int AS pinned_count,
            MAX(r.completed_at) AS last_run_at
        FROM workspaces w
        LEFT JOIN documents d ON d.workspace_id = w.id
        LEFT JOIN angles a ON a.workspace_id = w.id
        LEFT JOIN investigation_runs r ON r.workspace_id = w.id AND r.status = 'done'
        WHERE (expires_at IS NULL OR expires_at > NOW())
          AND (
            ($1::uuid IS NOT NULL AND w.guest_token = $1::uuid)
            OR ($2::text IS NOT NULL AND w.owner_email = $2)
          )
        GROUP BY w.id
        ORDER BY w.created_at DESC
    """, token, email)
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
                "saved": r["owner_email"] is not None,
            }
            for r in rows
        ]
    }


@router.get("/workspaces/{workspace_id}")
async def get_workspace(workspace_id: str, session: Session):
    token, email = session
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")

    _check_access(ws, token, email)

    docs, chunk_count, angles, runs = await asyncio.gather(
        pool().fetch(
            "SELECT id, filename, page_count, byte_size FROM documents WHERE workspace_id = $1 ORDER BY created_at",
            workspace_id,
        ),
        pool().fetchval("SELECT count(*)::int FROM chunks WHERE workspace_id = $1", workspace_id),
        pool().fetch("SELECT * FROM angles WHERE workspace_id = $1 ORDER BY created_at DESC", workspace_id),
        pool().fetch(
            "SELECT id, mode, prompt, status, started_at, completed_at, "
            "CASE WHEN row_number() OVER (ORDER BY started_at DESC) = 1 THEN trace ELSE NULL END AS trace "
            "FROM investigation_runs WHERE workspace_id = $1 ORDER BY started_at DESC",
            workspace_id,
        ),
    )

    return {
        "workspace": {
            "id": str(ws["id"]),
            "name": ws["name"],
            "status": ws["status"],
            "saved": ws["owner_email"] is not None,
            "ownerEmail": ws["owner_email"],
            "expiresAt": ws["expires_at"].isoformat() if ws["expires_at"] else None,
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
                    "trace": r["trace"] or [],
                }
                for r in runs
            ],
            "createdAt": ws["created_at"].isoformat(),
            "updatedAt": ws["updated_at"].isoformat(),
        }
    }


@router.post("/workspaces/{workspace_id}/reset-status")
async def reset_workspace_status(workspace_id: str, session: Session):
    token, email = session
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    _check_access(ws, token, email)
    await pool().execute(
        "UPDATE workspaces SET status = 'active', updated_at = NOW() "
        "WHERE id = $1 AND status = 'investigating'",
        workspace_id,
    )
    return {"status": "active"}


@router.patch("/workspaces/{workspace_id}")
async def rename_workspace(workspace_id: str, body: RenameRequest, session: Session):
    token, email = session
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty.")
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    _check_access(ws, token, email)
    row = await pool().fetchrow(
        "UPDATE workspaces SET name = $1 WHERE id = $2 RETURNING id, name",
        name, workspace_id,
    )
    return {"id": str(row["id"]), "name": row["name"]}


@router.delete("/workspaces/{workspace_id}", status_code=204)
async def delete_workspace(workspace_id: str, session: Session):
    token, email = session
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    _check_access(ws, token, email)

    # Delete files from Spaces before removing DB rows (CASCADE handles the rest)
    import os
    if all(os.environ.get(k) for k in ('DO_SPACES_ENDPOINT', 'DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET')):
        try:
            await delete_folder(f"documents/{workspace_id}/")
        except Exception:
            pass  # Don't block deletion if Spaces cleanup fails

    await pool().execute("DELETE FROM workspaces WHERE id = $1", workspace_id)


@router.post("/workspaces/{workspace_id}/claim")
async def claim_workspace(workspace_id: str, body: ClaimRequest, session: Session):
    token, email = session
    claim_email = body.email.strip().lower()
    if not claim_email or "@" not in claim_email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    _check_access(ws, token, email)
    await pool().execute(
        "UPDATE workspaces SET owner_email = $1, expires_at = NULL WHERE id = $2",
        claim_email, workspace_id,
    )
    return {"saved": True, "ownerEmail": claim_email}


@router.post("/workspaces", status_code=201)
async def create_workspace(
    session: Session,
    name: str = Form(...),
    files: list[UploadFile] = File(...),
):
    token, email = session
    _validate_files(files)
    try:
        result = await create_workspace_and_ingest(
            name, files, guest_token=token, owner_email=email
        )
        return {
            "workspaceId": result["workspaceId"],
            "status": "ready",
            "documentCount": result["documentCount"],
            "chunkCount": result["chunkCount"],
        }
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/workspaces/{workspace_id}/upload")
async def upload_to_workspace(
    session: Session,
    workspace_id: str,
    files: list[UploadFile] = File(...),
):
    token, email = session
    try:
        ws = await pool().fetchrow("SELECT * FROM workspaces WHERE id = $1", workspace_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    _check_access(ws, token, email)
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


@router.delete("/documents/{doc_id}", status_code=204)
async def delete_document(doc_id: str, session: Session):
    token, email = session
    try:
        row = await pool().fetchrow(
            "SELECT d.id, d.file_key, d.workspace_id, w.guest_token, w.owner_email "
            "FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = $1",
            doc_id,
        )
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Document not found.")
    if not row:
        raise HTTPException(status_code=404, detail="Document not found.")
    _check_access(row, token, email)

    import os
    if row["file_key"] and all(os.environ.get(k) for k in ('DO_SPACES_ENDPOINT', 'DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET')):
        try:
            await delete_object(row["file_key"])
        except Exception:
            pass

    await pool().execute("DELETE FROM documents WHERE id = $1", doc_id)


@router.get("/documents/{doc_id}/url")
async def get_document_url(doc_id: str):
    try:
        row = await pool().fetchrow("SELECT file_key FROM documents WHERE id = $1", doc_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Document not found.")
    if not row or not row["file_key"]:
        raise HTTPException(status_code=404, detail="No file stored for this document.")
    try:
        return {"url": presigned_url(row["file_key"])}
    except KeyError as e:
        raise HTTPException(status_code=503, detail=f"File storage not configured: missing env var {e}")


def _check_access(ws, token: str | None, email: str | None):
    if ws["owner_email"] and email and ws["owner_email"] == email:
        return
    if ws["guest_token"] and token:
        try:
            import uuid
            if ws["guest_token"] == uuid.UUID(token):
                return
        except (ValueError, AttributeError):
            pass
    if not ws["guest_token"] and not ws["owner_email"]:
        return  # legacy workspace (no token set), allow access
    raise HTTPException(status_code=403, detail="Access denied.")


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
