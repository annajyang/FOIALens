from fastapi import APIRouter, HTTPException
import asyncpg

from db.client import pool

router = APIRouter()


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    try:
        row = await pool().fetchrow("SELECT * FROM investigation_runs WHERE id = $1", run_id)
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Run not found.")
    if not row:
        raise HTTPException(status_code=404, detail="Run not found.")
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
