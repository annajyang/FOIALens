# FOIALens — Development Plan

## Guiding principle

Build in dependency order so each phase produces something verifiable before the next begins. The backend is fully testable with `curl` before the frontend exists. No phase should require speculative wiring.

---

## Phase 0 — Scaffold

**Goal:** Runnable Next.js app, database schema applied, all shared types defined. Nothing works yet, but the skeleton is in place and every subsequent phase has somewhere to land.

### Tasks

**Project init**
- `npx create-next-app@14 foialens --typescript --tailwind --app --src-dir=false --import-alias="@/*"`
- Add dependencies: `@anthropic-ai/sdk`, `openai`, `pdf-parse`, `pg`, `uuid`
- Add dev dependencies: `@types/pg`, `@types/pdf-parse`, `@types/uuid`, `ts-node`
- Write `.env.local.example` with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DATABASE_URL`
- Add `scripts/seed.ts` as a placeholder

**Types**
- Write `lib/types.ts` with all shared types from DATA_MODEL.md: `Workspace`, `Document`, `InvestigationRun`, `Angle`, `TraceEntry`, `EntityEntry`, `TimelineEvent`, and all union types (`WorkspaceStatus`, `AngleStatus`, `AngleType`, etc.)
- These types are the contract the rest of the codebase is written against. Get them right here.

**Database**
- Write `lib/db/schema.sql` (exact schema from DATA_MODEL.md: `workspaces`, `documents`, `chunks`, `investigation_runs`, `angles`)
- Write `lib/db/client.ts` — exports a singleton `pg.Pool`, reads `DATABASE_URL` from env
- `createdb foialens && psql foialens < lib/db/schema.sql`

**Next.js config**
- `next.config.js` — mark `pdf-parse` as a server-only external package to avoid bundling issues
- `app/layout.tsx` and `app/globals.css` — minimal shell, Tailwind base styles

### Done when
- `npm run dev` starts without errors
- `\dt` in psql shows all five tables
- `lib/types.ts` compiles cleanly

---

## Phase 1 — Ingestion pipeline

**Goal:** Upload a PDF via API, see its chunks and embeddings appear in Postgres. The agent cannot run without data; this is the foundation everything else reads from.

### Tasks

**PDF extraction** (`lib/ingestion/pdf-extractor.ts`)
- Wrap `pdf-parse` — accept a `Buffer`, return `PagedText[]`
- Strip form-feed characters and normalize whitespace
- Handle the `pdf-parse` test-file import quirk: import from `pdf-parse/lib/pdf-parse.js` directly to avoid module-load side effects in Next.js

**Chunker** (`lib/ingestion/chunker.ts`)
- Accept `PagedText[]`, return `Chunk[]`
- Sentence-boundary splitting using regex: `.`, `?`, `!` followed by whitespace; denylist for abbreviations (`U.S.`, `Dr.`, `Inc.`, etc.)
- Target ~2000 chars (~500 tokens) per chunk; fallback to clause boundary (`;`, conjunction-led clause) for oversized sentences
- 200-char overlap: append tail of chunk N as prefix to chunk N+1
- Tag each chunk with `startPage`, `endPage`, `chunkIndex`

**Embedder** (`lib/ingestion/embedder.ts`)
- Accept `string[]`, return `number[][]` (one embedding vector per input)
- Use `openai.embeddings.create({ model: "text-embedding-3-small", input })` in batches of 100
- Single exported function: `embedTexts(texts: string[]): Promise<number[][]>`

**Upload orchestrator** (`lib/ingestion/upload.ts`)
- Accept `(files: File[], workspaceId: string)`
- For each file: extract → chunk → embed → bulk-insert documents and chunks
- Use a single Postgres transaction per file so partial failures don't leave orphan rows
- Upsert workspace status to `ready` when all files are done

**API routes**
- `POST /api/workspaces` — create workspace row, call upload orchestrator, return `{ workspaceId, status, documentCount, chunkCount }`
- `POST /api/workspaces/[workspaceId]/upload` — add documents to existing workspace; reject with `409 RUN_IN_PROGRESS` if status is `investigating`

### Done when
```bash
curl -X POST http://localhost:3000/api/workspaces \
  -F "name=Test Investigation" \
  -F "files=@sample.pdf"
# → { "workspaceId": "...", "status": "ready", "chunkCount": 47 }

psql foialens -c "SELECT count(*) FROM chunks WHERE workspace_id = '<id>';"
# → 47

psql foialens -c "SELECT embedding IS NOT NULL FROM chunks LIMIT 1;"
# → t
```

---

## Phase 2 — Tool suite

**Goal:** Each tool works correctly in isolation when called with a real workspace ID. The agent loop in Phase 3 is just a dispatcher — the tools need to be solid first.

### Tasks

**`search_documents`** (`lib/tools/search-documents.ts`)
- Embed the query string, run cosine similarity search against `chunks` for the given `workspace_id`
- Default `limit: 10`, accept optional override
- Return `{ results: Array<{ content, startPage, endPage, documentName, similarity }> }`
- Verify the pgvector `<=>` operator returns sensible rankings on real data before moving on

**`extract_entities`** (`lib/tools/extract-entities.ts`)
- Fetch up to 20 chunks (by document or full workspace) as context
- Call Claude Haiku (`claude-haiku-4-5-20251001`) with a structured extraction prompt
- Prompt instructs Haiku to return only JSON matching the entity schema — no prose
- Parse and validate response; return `{ entities, newCount }`
- `newCount` is entities not already present in the run's accumulated entity set (passed in from the loop)

**`build_timeline`** (`lib/tools/build-timeline.ts`)
- Run several targeted `search_documents` calls internally: `"signed"`, `"approved"`, `"effective date"`, `"meeting minutes"`, `"agreement"`
- Deduplicate chunks by ID across the searches
- Call Haiku to extract `(date, description, significance)` tuples
- Sort chronologically; flag relative dates as `confidence: "low"`
- Return `{ events }`

**`propose_angle`** (`lib/tools/propose-angle.ts`)
- Validate input against the `Angle` schema
- Insert a row into `angles` table with status `proposed`
- Return `{ angleId, accepted: true }`
- This tool has a side effect (DB write) that the loop relies on — make sure the insert is synchronous before returning

**Tool registry** (`lib/tools/index.ts`)
- Export two things:
  1. `TOOL_DEFINITIONS: Tool[]` — the Anthropic-schema definitions for all four tools (used by the agent loop to pass to the API)
  2. `dispatchTool(name, input, workspaceId, runId): Promise<unknown>` — the switch statement that routes a tool call to its implementation

### Done when
```bash
# test script (scripts/test-tools.ts)
npx ts-node scripts/test-tools.ts <workspaceId>
# Runs each tool and prints its output. All four should return valid JSON
# with no TypeScript errors and no DB constraint violations.
```

Write `scripts/test-tools.ts` as part of this phase. It's not a unit test suite — it's an integration smoke test against a real DB with real chunks.

---

## Phase 3 — Agentic loop + investigate endpoint

**Goal:** Trigger an investigation from the command line and watch SSE events stream out. Angles appear in the `angles` table as the agent runs.

### Tasks

**System prompts** (`lib/agent/prompts.ts`)
- `buildSystemPrompt(mode: "exploratory" | "directed"): string`
- `buildUserTurn(workspaceId: string, prompt: string | null, workspaceContext: WorkspaceContext): string`
- `WorkspaceContext` contains: workspace name, document list, prior angle count, pinned angle titles — injected so the agent doesn't re-surface already-triaged findings
- Keep prompts in this file, not inline in the loop, so they're easy to iterate without touching control flow

**Investigator** (`lib/agent/investigator.ts`)
- `runInvestigation(params, onEvent)` — the main export
  - `params`: `{ workspaceId, runId, mode, prompt, workspaceContext }`
  - `onEvent`: `(event: SSEEvent) => void` — callback the route handler uses to write to the stream
- Set workspace status to `investigating` and run status to `investigating` at start
- Build initial messages array, enter the tool-use loop
- After each `tool_use` block: call `dispatchTool`, call `onEvent` with a `trace` event
- After `propose_angle` resolves: call `onEvent` with `angle_proposed`
- On `end_turn`: extract final text block as the run summary, persist `run.summary`, `run.trace`, `run.status = "done"`, merge entities/timeline into `workspace.entities`/`workspace.timeline`, set workspace status to `active`
- On any thrown error: set `run.status = "error"`, `run.error = message`, reset workspace status

**Investigate route** (`app/api/investigate/route.ts`)
- Set `export const maxDuration = 300`
- Parse and validate request body
- Reject if workspace not found, status is `ingesting`, or another run is `investigating`
- Create `investigation_runs` row
- Build a `ReadableStream` that calls `runInvestigation` with an `onEvent` callback that enqueues SSE-formatted chunks
- Return `new Response(stream, { headers: { "Content-Type": "text/event-stream", ... } })`

### Done when
```bash
# 1. Trigger an investigation
curl -X POST http://localhost:3000/api/investigate \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"<id>","mode":"exploratory"}' \
  --no-buffer

# Should stream SSE events to the terminal:
# data: {"type":"status","message":"Starting exploratory scan…"}
# data: {"type":"trace","tool":"search_documents",…}
# data: {"type":"angle_proposed","angle":{…}}
# ... more traces and angles ...
# data: {"type":"done","runId":"…","angleCount":5}

# 2. After stream ends, check DB
psql foialens -c "SELECT title, newsworthiness, status FROM angles WHERE workspace_id = '<id>';"
# Should show 4–8 rows all with status = 'proposed'

psql foialens -c "SELECT status FROM workspaces WHERE id = '<id>';"
# Should show 'active'
```

---

## Phase 4 — Remaining API routes

**Goal:** All endpoints specified in API_SPEC.md are implemented. The frontend has a complete API to call.

These routes are simple reads/writes — no streaming, no agent calls. Build them all in one session.

### Tasks

- `GET /api/workspaces` — query all workspaces with doc count, angle count, pinned count, last run timestamp
- `GET /api/workspaces/[workspaceId]` — full workspace detail: documents, all angles (any status), entities, timeline, runs list
- `PATCH /api/workspaces/[workspaceId]` — update `name`, validate max length
- `PATCH /api/angles/[angleId]` — update `status`; validate value is `proposed | pinned | dismissed`
- `GET /api/runs/[runId]` — full run detail including complete trace

### Done when
```bash
# Spot-check each endpoint
curl http://localhost:3000/api/workspaces
curl http://localhost:3000/api/workspaces/<id>
curl -X PATCH http://localhost:3000/api/workspaces/<id> \
  -H "Content-Type: application/json" -d '{"name":"Renamed"}'
curl -X PATCH http://localhost:3000/api/angles/<angleId> \
  -H "Content-Type: application/json" -d '{"status":"pinned"}'
curl http://localhost:3000/api/runs/<runId>
# All return expected JSON with correct shapes
```

---

## Phase 5 — Frontend: core workspace

**Goal:** The full primary user flow works end-to-end in the browser: create a workspace, ingest documents, run an investigation, watch angles appear as cards, triage them.

Build components bottom-up: smallest/most isolated first, composed into pages last.

### Tasks

**`components/UploadZone.tsx`**
- Drag-and-drop + click-to-browse for PDFs
- Shows file list with names and sizes before submission
- Submit calls `POST /api/workspaces` (on creation) or `POST /api/workspaces/[id]/upload` (on add)
- Shows ingestion progress (word count or "Indexing…" spinner), then navigates to workspace on success

**`components/AngleCard.tsx`**
- Displays: title, newsworthiness badge, angle type badge, summary, evidence bullets, citations
- Three action buttons: Pin / Dismiss / (already proposed — no action)
- Pinned state: card gets a visual treatment (border, star icon)
- Dismissed state: card grays out with an "Undo" affordance
- Calls `PATCH /api/angles/[angleId]` on action; optimistic UI update

**`components/WorkspaceBoard.tsx`**
- Accepts `angles: Angle[]` and `isInvestigating: boolean`
- Renders a masonry grid of `AngleCard`s
- Filter tabs: All · Pinned · Proposed · Dismissed
- During investigation: a "Scanning…" placeholder card appears while agent is running, disappears when the first real angle arrives
- Angles animate in as they arrive (`angle_proposed` SSE events)

**`components/InvestigatePanel.tsx`**
- Mode toggle: Explore / Directed
- Prompt textarea (shown only in Directed mode)
- Investigate button — disabled if workspace is `ingesting` or `investigating`
- During investigation: shows a live status message from the `status` SSE events

**`app/workspace/[workspaceId]/page.tsx`**
- Client component (`"use client"`)
- On mount: `GET /api/workspaces/[workspaceId]` to hydrate initial state (existing angles, workspace name, status)
- When Investigate is triggered: `POST /api/investigate`, read the stream, dispatch events to state
- Render: left panel with `InvestigatePanel` + corpus file list; main area with `WorkspaceBoard`

**`app/page.tsx`** (home)
- Fetch and display workspace list
- Each workspace: name, doc count, angle count (pinned / total), last run date
- "New investigation" button → shows `UploadZone` inline or in a modal
- Clicking a workspace navigates to `/workspace/[id]`

### Done when
- Create a workspace from the browser, upload a PDF, click Investigate (exploratory)
- Angle cards appear on the board in real time as the agent proposes them
- Pin one angle, dismiss another — status persists on page refresh
- Navigate back to the home page — workspace appears in the list

---

## Phase 6 — Frontend: secondary panels

**Goal:** Entity map, timeline, and agent trace are populated and accessible. These are secondary to the angles board but complete the workspace.

### Tasks

**`components/AgentTrace.tsx`**
- Collapsible panel (collapsed by default, expandable by the journalist)
- Each trace entry: tool icon, tool name, input summary, result summary, timestamp
- Entries appear in real time during investigation (from `trace` SSE events)
- After investigation: shows full trace from `GET /api/runs/[runId]`
- Run selector if multiple runs exist

**`components/EntityMap.tsx`**
- Grouped by entity type (People / Organizations / Amounts / Locations / Dates)
- Each entity: name, mention count, representative context, page refs as clickable badges
- Sorted by mention count descending
- Accumulated across all runs (reads from `workspace.entities`)

**`components/Timeline.tsx`**
- Chronological list of events with date, description, significance
- Confidence indicator (high / medium / low)
- Page ref badges
- "circa YYYY" dates displayed with a ~ prefix

Wire all three into the left panel of `app/workspace/[workspaceId]/page.tsx` as collapsible sections below the corpus file list.

### Done when
- Run an investigation, expand the trace panel — all tool calls visible with inputs and results
- Entity map shows deduplicated entities with correct mention counts
- Timeline shows events in chronological order

---

## Phase 7 — Seed script and hardening

**Goal:** The project is demonstrable to someone who just cloned it, and the common failure paths are handled gracefully.

### Tasks

**Seed script** (`scripts/seed.ts`)
- Downloads a specific public-domain FOIA release (a small, interesting one — e.g., a city budget document or court filing) and stores it in `scripts/fixtures/sample.pdf`
- Creates a workspace named "Sample — [document title]"
- Runs ingestion
- Prints `Workspace created: http://localhost:3000/workspace/<id>`
- Running it twice should not create duplicate workspaces (check by name before creating)

**Error handling pass**
- Upload endpoint: user-facing error message if PDF has no extractable text (scanned image)
- Investigate endpoint: if Claude returns a malformed tool call, log it and continue rather than crashing the loop
- All API routes: catch unexpected DB errors and return `500` with a generic message (not a stack trace)

**Loading and empty states**
- Home page: empty state if no workspaces yet ("Drop in your first document set to get started")
- Workspace board: empty state before the first investigation ("Run an exploration to discover story angles")
- While ingesting (status: `ingesting`): show a progress indicator, disable the Investigate button

**`npm run seed`** entry in `package.json`
```json
"scripts": {
  "seed": "npx ts-node --project tsconfig.scripts.json scripts/seed.ts"
}
```

### Done when
- `npm run seed` runs cleanly on a fresh database and opens a usable workspace
- Uploading a scanned (image-only) PDF shows a clear error in the UI rather than crashing
- Refreshing the page mid-investigation correctly restores state

---

## Build order summary

```
Phase 0 — Scaffold           ██░░░░░░░░░░░░░░░░░░░░░░░░  (1–2 hrs)
Phase 1 — Ingestion          ████░░░░░░░░░░░░░░░░░░░░░░  (3–4 hrs)
Phase 2 — Tool suite         ████░░░░░░░░░░░░░░░░░░░░░░  (3–4 hrs)
Phase 3 — Agent loop         ████░░░░░░░░░░░░░░░░░░░░░░  (3–4 hrs)
Phase 4 — Remaining APIs     ██░░░░░░░░░░░░░░░░░░░░░░░░  (1–2 hrs)
Phase 5 — Core frontend      █████░░░░░░░░░░░░░░░░░░░░░  (4–5 hrs)
Phase 6 — Secondary panels   ███░░░░░░░░░░░░░░░░░░░░░░░  (2–3 hrs)
Phase 7 — Seed + hardening   ██░░░░░░░░░░░░░░░░░░░░░░░░  (1–2 hrs)
─────────────────────────────────────────────────────────
Total                                                      ~18–26 hrs
```

Phases 4 and 5 can be worked in parallel if there are two people — they share no code. Everything else in the backend stack (0 → 1 → 2 → 3) is strictly sequential.

---

## What to defer

These are real features but not needed for a working prototype:

- **Multi-user / auth** — right now any session can see any workspace. Add NextAuth or Clerk when the tool leaves single-user development.
- **Angle notes** — journalists annotating angles with their own text. The DB can store it (add a `notes TEXT` column to `angles`), but the UI editor is out of scope.
- **Export** — copy angle to clipboard as AP-formatted text, or export workspace as PDF. Useful, not essential.
- **Re-embedding on model change** — if the embedding model changes, all chunks need to be re-embedded. Build this as a migration script only when it's needed.

---

## If time — stretch features

These extend the core loop meaningfully and should be tackled in the order listed if the prototype is solid and time allows.

### 1. Image document processing (OCR)

Right now, scanned PDFs with no text layer are silently skipped. Adding OCR unlocks the large portion of FOIA releases that arrive as image scans.

**Approach:**
- In `lib/ingestion/pdf-extractor.ts`, after extracting text per page, check if the page is effectively empty (< 50 non-whitespace characters).
- For empty pages, send the page image to **Claude's vision API** (`claude-sonnet-4-20250514` supports image input). Encode the page as a base64 PNG and prompt Claude to transcribe the visible text verbatim, preserving layout where meaningful.
- This keeps OCR in-process with no new API keys. Cost is higher (~$0.005–0.02 per page) — acceptable for FOIA work.
- Add a `ocr_processed: boolean` column to `chunks` so the UI can flag OCR-derived text (accuracy is lower than native text extraction).

**Schema addition:**
```sql
ALTER TABLE chunks ADD COLUMN ocr_processed BOOLEAN NOT NULL DEFAULT FALSE;
```

**UI:** Show a small "OCR" badge on angles whose citations reference OCR-processed pages.

---

### 2. Web corpus expansion

Lets the agent pull in external context — prior coverage, government databases, corporate filings — to enrich the investigation.

**New tool: `search_web(query: string, intent: string)`**

- Calls a web search API (Brave Search or Tavily — both have simple REST APIs and $0 free tiers for development).
- Returns the top 5 results with title, URL, and a snippet.
- The agent uses this to find: prior news coverage of key entities, public company or nonprofit filings, government contract databases (USASpending.gov, SAM.gov), court records.
- Results are NOT chunked or embedded — they're returned to the agent as plain text context, not stored. This keeps the corpus clean (only uploaded documents are in the DB).

**New tool: `fetch_url(url: string)`**

- Fetches the full text of a URL the agent wants to read (after `search_web` surfaces it).
- Use `fetch` + basic HTML-to-text stripping. Max 10k characters returned to keep context manageable.
- Only call external URLs — reject `localhost` and RFC1918 addresses.

**Agent behavior:** In the exploratory system prompt, add a clause: *"If you identify a key person or organization, consider using search_web to find prior public reporting or filings that add context."* In directed mode, include web search as a natural research step.

**Schema addition:**
```sql
-- Track which angles were informed by web sources (for transparency)
ALTER TABLE angles ADD COLUMN web_sources JSONB NOT NULL DEFAULT '[]';
-- web_sources shape: Array<{ url: string; title: string; snippet: string }>
```

**Cost:** Brave Search free tier is 2,000 calls/month. Tavily's free tier is similar. Budget $0–5/month for development.

**Security note:** The `fetch_url` tool must validate the URL is a public address before fetching. Never fetch URLs containing credentials or private network addresses.

---

### Integration order

Build OCR before web search — OCR expands the ingestion pipeline (Phase 1), while web search expands the tool suite (Phase 2). Both can be feature-flagged behind environment variables (`ENABLE_OCR=true`, `ENABLE_WEB_SEARCH=true`) so the core prototype works without them.
