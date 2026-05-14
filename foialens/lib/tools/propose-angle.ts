import pool from '@/lib/db/client';
import type { AngleType, Newsworthiness, Citation } from '@/lib/types';

export interface ProposeAngleInput {
  title: string;
  summary: string;
  newsworthiness: Newsworthiness;
  angleType: AngleType;
  evidence: string[];
  citations: Citation[];
}

export async function proposeAngle(
  input: ProposeAngleInput,
  workspaceId: string,
  runId: string,
): Promise<{ angleId: string; accepted: true }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO angles
       (workspace_id, run_id, title, summary, newsworthiness,
        angle_type, evidence, citations, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed')
     RETURNING id`,
    [
      workspaceId,
      runId,
      input.title,
      input.summary,
      input.newsworthiness,
      input.angleType,
      JSON.stringify(input.evidence),
      JSON.stringify(input.citations),
    ],
  );

  return { angleId: rows[0].id, accepted: true };
}
