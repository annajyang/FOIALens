import asyncpg
from fastapi import APIRouter, HTTPException

from auth_utils import Session, check_workspace_access
from db.client import pool

router = APIRouter()


@router.get("/runs/{run_id}")
async def get_run(run_id: str, session: Session):
    token, email = session
    try:
        row = await pool().fetchrow(
            "SELECT r.*, w.guest_token, w.owner_email "
            "FROM investigation_runs r JOIN workspaces w ON w.id = r.workspace_id "
            "WHERE r.id = $1",
            run_id,
        )
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Run not found.")
    if not row:
        raise HTTPException(status_code=404, detail="Run not found.")
    check_workspace_access(row, token, email)
    return {
        "id":          str(row["id"]),
        "workspaceId": str(row["workspace_id"]),
        "mode":        row["mode"],
        "prompt":      row["prompt"],
        "status":      row["status"],
        "summary":     row["summary"],
        "trace":       row["trace"] or [],
        "error":       row["error"],
        "startedAt":   row["started_at"].isoformat(),
        "completedAt": row["completed_at"].isoformat() if row["completed_at"] else None,
    }
