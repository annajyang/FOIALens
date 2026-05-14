import asyncpg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db.client import pool

router = APIRouter()

VALID_STATUSES = {"proposed", "pinned", "dismissed"}


class PatchAngleBody(BaseModel):
    status: str


@router.patch("/angles/{angle_id}")
async def patch_angle(angle_id: str, body: PatchAngleBody):
    if body.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f'status must be one of: {", ".join(sorted(VALID_STATUSES))}')

    try:
        row = await pool().fetchrow(
            "UPDATE angles SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status",
            body.status, angle_id,
        )
    except asyncpg.DataError:
        raise HTTPException(status_code=404, detail="Angle not found.")
    if not row:
        raise HTTPException(status_code=404, detail="Angle not found.")

    return {"id": str(row["id"]), "status": row["status"]}
