import json

from db.client import pool


async def propose_angle(input: dict, workspace_id: str, run_id: str) -> dict:
    row = await pool().fetchrow(
        "INSERT INTO angles "
        "  (workspace_id, run_id, title, summary, newsworthiness, "
        "   angle_type, evidence, citations, status) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'proposed') "
        "RETURNING id",
        workspace_id,
        run_id,
        input["title"],
        input["summary"],
        input["newsworthiness"],
        input["angleType"],
        json.dumps(input["evidence"]),
        json.dumps(input["citations"]),
    )
    return {"angleId": str(row["id"]), "accepted": True}
