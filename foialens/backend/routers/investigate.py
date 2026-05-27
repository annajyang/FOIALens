import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from db.client import pool
from agent.investigator import InvestigationParams, run_investigation
from agent.prompts import WorkspaceContext

router = APIRouter()


class InvestigateRequest(BaseModel):
    workspaceId: str
    mode: str
    prompt: str | None = None


@router.post("/investigate")
async def investigate(body: InvestigateRequest):
    if body.mode not in ("exploratory", "directed"):
        raise HTTPException(status_code=400, detail='mode must be "exploratory" or "directed".')
    cleaned_prompt = (body.prompt or "").strip() or None
    if body.mode == "directed" and not cleaned_prompt:
        raise HTTPException(status_code=400, detail="A prompt is required for directed mode.")

    ws = await pool().fetchrow(
        "SELECT name, status, entities, timeline FROM workspaces WHERE id = $1",
        body.workspaceId,
    )
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    if ws["status"] == "ingesting":
        raise HTTPException(status_code=409, detail="Document ingestion is still in progress.")
    if ws["status"] == "investigating":
        raise HTTPException(status_code=409, detail="Another investigation is already running.")

    docs, chunk_row, prior_row, pinned_rows, prior_angle_rows = await _fetch_context(body.workspaceId)

    pinned_titles = [r["title"] for r in pinned_rows]
    prior_titles  = [r["title"] for r in prior_angle_rows if r["title"] not in pinned_titles]

    workspace_context = WorkspaceContext(
        name=ws["name"],
        documents=[{"filename": r["filename"], "pageCount": r["page_count"]} for r in docs],
        chunk_count=chunk_row,
        prior_runs=prior_row,
        pinned_angle_titles=pinned_titles,
        prior_angle_titles=prior_titles,
        existing_entities=ws["entities"] or [],
        existing_timeline=ws["timeline"] or [],
    )

    run_row = await pool().fetchrow(
        "INSERT INTO investigation_runs (workspace_id, mode, prompt, status) "
        "VALUES ($1, $2, $3, 'investigating') RETURNING id",
        body.workspaceId, body.mode, cleaned_prompt,
    )
    run_id = str(run_row["id"])

    params = InvestigationParams(
        workspace_id=body.workspaceId,
        run_id=run_id,
        mode=body.mode,
        prompt=cleaned_prompt,
        workspace_context=workspace_context,
    )

    async def event_stream():
        try:
            async for event in run_investigation(params):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            # Guarantee workspace is never left stuck in 'investigating' status.
            await pool().execute(
                "UPDATE workspaces SET status = 'active', updated_at = NOW() "
                "WHERE id = $1 AND status = 'investigating'",
                body.workspaceId,
            )
            await pool().execute(
                "UPDATE investigation_runs SET status = 'error', error = 'interrupted', completed_at = NOW() "
                "WHERE id = $1 AND status = 'investigating'",
                run_id,
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive"},
    )


async def _fetch_context(workspace_id: str):
    docs, chunk_count, prior_runs, pinned = await asyncio.gather(
        pool().fetch(
            "SELECT filename, page_count FROM documents WHERE workspace_id = $1 ORDER BY created_at",
            workspace_id,
        ),
        pool().fetchval("SELECT count(*)::int FROM chunks WHERE workspace_id = $1", workspace_id),
        pool().fetchval(
            "SELECT count(*)::int FROM investigation_runs WHERE workspace_id = $1 AND status = 'done'",
            workspace_id,
        ),
        pool().fetch("SELECT title FROM angles WHERE workspace_id = $1 AND status = 'pinned'", workspace_id),
    )
    return docs, chunk_count, prior_runs, pinned, []
