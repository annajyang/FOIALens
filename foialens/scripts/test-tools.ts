/**
 * Integration smoke test for the tool suite.
 * Requires a workspace with ingested chunks (run the API upload first).
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/test-tools.ts <workspaceId>
 *
 * Also requires ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment
 * (or in .env.local — load it manually if needed).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

// Load .env.local manually since ts-node doesn't use Next.js env loading
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

import { searchDocuments } from '../lib/tools/search-documents';
import { extractEntities } from '../lib/tools/extract-entities';
import { buildTimeline } from '../lib/tools/build-timeline';
import { proposeAngle } from '../lib/tools/propose-angle';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error('Usage: ts-node scripts/test-tools.ts <workspaceId>');
    process.exit(1);
  }

  console.log(`\nTesting tools against workspace: ${workspaceId}\n`);

  // Verify workspace exists and has chunks
  const { rows: wsRows } = await pool.query(
    'SELECT name, status FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (wsRows.length === 0) {
    console.error('Workspace not found.');
    process.exit(1);
  }
  const { rows: chunkRows } = await pool.query(
    'SELECT count(*)::int AS n FROM chunks WHERE workspace_id = $1',
    [workspaceId],
  );
  console.log(`Workspace: "${wsRows[0].name}" | status: ${wsRows[0].status} | chunks: ${chunkRows[0].n}\n`);

  // ── 1. search_documents ───────────────────────────────────────────────────
  console.log('── search_documents ─────────────────────────────────────────');
  const searchResult = await searchDocuments('payment contract agreement', workspaceId, 3);
  console.log(`  Results: ${searchResult.results.length}`);
  for (const r of searchResult.results) {
    console.log(`  [${r.similarity.toFixed(3)}] p.${r.startPage}–${r.endPage} ${r.documentName}`);
    console.log(`    "${r.content.slice(0, 100).replace(/\n/g, '↵')}..."`);
  }
  console.log();

  // ── 2. extract_entities ───────────────────────────────────────────────────
  console.log('── extract_entities ─────────────────────────────────────────');
  const entityResult = await extractEntities('full', workspaceId);
  console.log(`  Entities found: ${entityResult.entities.length} (${entityResult.newCount} new)`);
  for (const e of entityResult.entities.slice(0, 5)) {
    console.log(`  [${e.type}] ${e.name} — ${e.mentions} mention(s), p.${e.pageRefs.join(',')}`);
  }
  if (entityResult.entities.length > 5) {
    console.log(`  ... and ${entityResult.entities.length - 5} more`);
  }
  console.log();

  // ── 3. build_timeline ─────────────────────────────────────────────────────
  console.log('── build_timeline ───────────────────────────────────────────');
  const timelineResult = await buildTimeline(workspaceId);
  console.log(`  Events found: ${timelineResult.events.length}`);
  for (const e of timelineResult.events.slice(0, 5)) {
    console.log(`  [${e.confidence}] ${e.date} — ${e.description.slice(0, 80)}`);
  }
  console.log();

  // ── 4. propose_angle ──────────────────────────────────────────────────────
  console.log('── propose_angle ────────────────────────────────────────────');
  // Need a real run ID — use an existing one or create a test run
  let runId: string;
  const { rows: runRows } = await pool.query(
    'SELECT id FROM investigation_runs WHERE workspace_id = $1 LIMIT 1',
    [workspaceId],
  );
  if (runRows.length > 0) {
    runId = runRows[0].id;
    console.log(`  Using existing run: ${runId}`);
  } else {
    const { rows: newRun } = await pool.query<{ id: string }>(
      `INSERT INTO investigation_runs (workspace_id, mode, status)
       VALUES ($1, 'exploratory', 'done') RETURNING id`,
      [workspaceId],
    );
    runId = newRun[0].id;
    console.log(`  Created test run: ${runId}`);
  }

  const angleResult = await proposeAngle(
    {
      title: 'Test angle — delete after verifying',
      summary: 'This is a test angle created by the Phase 2 smoke test script.',
      newsworthiness: 'low',
      angleType: 'other',
      evidence: ['Test evidence item (p. 1)'],
      citations: [{ page: 1, excerpt: 'Test excerpt from document.' }],
    },
    workspaceId,
    runId,
  );
  console.log(`  Angle inserted: ${angleResult.angleId}`);
  console.log(`  Accepted: ${angleResult.accepted}`);

  // Verify it landed in the DB
  const { rows: angleRows } = await pool.query(
    'SELECT title, status FROM angles WHERE id = $1',
    [angleResult.angleId],
  );
  console.log(`  DB check: "${angleRows[0].title}" | status: ${angleRows[0].status}`);
  console.log();

  console.log('All tools passed.\n');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  pool.end();
  process.exit(1);
});
