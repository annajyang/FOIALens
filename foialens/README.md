# FOIALens

AI-powered investigative workspace for journalists. Drop in a FOIA document dump, get back a living investigation: named story angles with cited evidence, a shared entity map, and a timeline — all in a workspace you can return to, extend, and build on.

---

## What it does

### Two investigation modes

**Exploratory** — No upfront goal. The agent scans the corpus looking for anything newsworthy: unusual financial patterns, anomalous relationships, gaps in the record, unexpected names. Surfaces 4–8 distinct story angles ranked by newsworthiness, each with evidence and page citations.

**Directed** — You bring a hypothesis. Type a specific question or focus (e.g., *"Who authorized the no-bid contracts to Acme Corp and when?"*). The agent searches the corpus to build or undermine that specific case, then surfaces angles related to your goal.

Both modes can be run repeatedly against the same workspace as your investigation evolves.

### The workspace

Each uploaded document set lives in a **workspace** — a persistent investigation environment you can name and return to. Within a workspace you can:

- Run exploratory scans to discover angles you hadn't considered
- Run directed investigations to chase down specific leads
- **Pin** angles you want to develop, **dismiss** ones that don't hold up
- Watch the shared entity map and timeline grow across runs
- See the full agent reasoning trace for every investigation

Angles are the primary artifact. Each one is a discrete story opportunity: a working headline, a two-sentence summary of the news, supporting evidence bullets, and verbatim document excerpts with page numbers.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 |
| PostgreSQL | ≥ 15 with pgvector extension |
| Anthropic API key | — |
| OpenAI API key | Used only for `text-embedding-3-small` embeddings |

> **Why two API keys?** Anthropic does not expose an embeddings endpoint. OpenAI's `text-embedding-3-small` is cheap (~$0.02 / million tokens) and pairs naturally with pgvector. The Claude API is used for all reasoning.

---

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd foialens
npm install
```

### 2. Environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
# Anthropic — agentic reasoning loop
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI — embeddings only
OPENAI_API_KEY=sk-...

# Postgres with pgvector
DATABASE_URL=postgresql://user:password@localhost:5432/foialens
```

### 3. Database setup

```bash
createdb foialens
psql foialens < lib/db/schema.sql
```

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Usage

### Create a workspace

From the home page, drag in one or more PDFs and give the workspace a name (e.g., *"City Hall Contracts 2019–2023"*). FOIALens ingests the documents — extracting text, chunking, embedding, storing — then opens the workspace.

### Run an exploratory scan

With no prompt, click **Scan for angles**. The agent works through the corpus and proposes angles as it finds them — you see them appear in real time as cards on the workspace board. When the scan finishes you have a set of proposed angles to triage.

### Run a directed investigation

Type a focus question and click **Investigate**. The agent pursues that specific thread and surfaces the most relevant angles it can support with evidence.

### Triage angles

Each angle card shows:
- Working headline
- Two-sentence newsworthiness summary
- Key supporting facts with `(p. N)` citations
- Verbatim document excerpts

Mark each one **Pin** (worth developing), **Dismiss** (doesn't hold up), or leave as **Proposed** to revisit. Pinned angles are highlighted at the top of the board.

### Iterate

Run another investigation — exploratory or directed — at any time. New angles are added to the board; the entity map and timeline accumulate across runs. The workspace is a running record of your investigation.

### Seed with a sample document

```bash
npm run seed
```

Ingests a sample public-domain FOIA release and opens a workspace in the browser.

---

## Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | Server components + streaming responses |
| Language | TypeScript | End-to-end type safety |
| Database | PostgreSQL + pgvector | Relational + semantic search in one store |
| Agent | Claude Sonnet (`claude-sonnet-4-20250514`) | Tool use + long-context reasoning |
| Embeddings | OpenAI `text-embedding-3-small` | Best cost/quality for semantic retrieval |
| PDF parsing | `pdf-parse` | Lightweight, page-number aware |
| Styling | Tailwind CSS | Utility-first, no build-step CSS |

---

## Project structure

```
foialens/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                               # Home — list workspaces, create new
│   ├── globals.css
│   ├── workspace/[workspaceId]/
│   │   └── page.tsx                           # Investigation workspace
│   └── api/
│       ├── workspaces/
│       │   ├── route.ts                       # GET list, POST create
│       │   └── [workspaceId]/
│       │       ├── route.ts                   # GET workspace detail
│       │       └── upload/route.ts            # POST add documents
│       ├── investigate/route.ts               # POST trigger run (SSE stream)
│       └── angles/
│           └── [angleId]/route.ts             # PATCH update angle status
├── components/
│   ├── WorkspaceBoard.tsx                     # Angle card grid + triage controls
│   ├── AngleCard.tsx                          # Single angle with evidence
│   ├── UploadZone.tsx
│   ├── InvestigatePanel.tsx                   # Mode selector + prompt input
│   ├── AgentTrace.tsx                         # Collapsible reasoning trace
│   ├── EntityMap.tsx                          # Accumulated entity list
│   └── Timeline.tsx                           # Accumulated timeline
├── lib/
│   ├── db/
│   │   ├── client.ts
│   │   └── schema.sql
│   ├── ingestion/
│   │   ├── pdf-extractor.ts
│   │   ├── chunker.ts
│   │   ├── embedder.ts
│   │   └── upload.ts
│   ├── tools/
│   │   ├── index.ts
│   │   ├── search-documents.ts
│   │   ├── extract-entities.ts
│   │   ├── build-timeline.ts
│   │   └── propose-angle.ts                  # Agent proposes a story angle
│   ├── agent/
│   │   ├── investigator.ts                   # Agentic loop
│   │   └── prompts.ts                        # Mode-specific system prompts
│   └── types.ts
├── scripts/
│   └── seed.ts
├── docs/
│   ├── SPEC.md
│   ├── DATA_MODEL.md
│   └── API_SPEC.md
└── .env.local.example
```

---

## Cost estimate

A typical 500-page FOIA dump (roughly 250k tokens of text):

| Operation | Estimated cost |
|---|---|
| Embedding all chunks (~500 chunks) | ~$0.01 |
| One exploratory scan (15–20 tool calls, 6–8 angles) | ~$0.30–0.60 |
| One directed investigation (10–15 tool calls, 2–4 angles) | ~$0.15–0.40 |
| **Per-investigation total** | **< $0.65** |

---

## Known limitations

- PDFs with scanned images (no text layer) are not supported — no OCR. Pre-process with AWS Textract or Google Document AI.
- No collaborative editing — workspaces are single-user. Angles are not shared or commented on in real time.
- Investigation runs within a workspace are sequential; starting a second run while one is in progress is rejected.
