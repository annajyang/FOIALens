import re

from db.client import pool

_STOPWORDS = {
    'a', 'an', 'and', 'are', 'at', 'be', 'been', 'by', 'for', 'had',
    'has', 'have', 'in', 'is', 'its', 'of', 'on', 'or', 'that', 'the',
    'this', 'to', 'was', 'were', 'with',
}
_DUPLICATE_THRESHOLD = 0.5


def _title_words(title: str) -> set[str]:
    return {
        w.lower() for w in re.findall(r'\w+', title)
        if len(w) > 2 and w.lower() not in _STOPWORDS
    }


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


async def propose_angle(input: dict, workspace_id: str, run_id: str) -> dict:
    incoming_words = _title_words(input["title"])

    # Check all non-dismissed angles for near-duplicate titles.
    existing = await pool().fetch(
        "SELECT id, title FROM angles WHERE workspace_id = $1 AND status != 'dismissed'",
        workspace_id,
    )
    for row in existing:
        if _jaccard(incoming_words, _title_words(row["title"])) >= _DUPLICATE_THRESHOLD:
            # Return the existing angle ID rather than creating a duplicate.
            return {
                "angleId":       str(row["id"]),
                "accepted":      True,
                "isDuplicate":   True,
                "existingTitle": row["title"],
            }

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
        input["evidence"],
        input["citations"],
    )
    return {"angleId": str(row["id"]), "accepted": True}
