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

| Requirement | Version | Used for |
|---|---|---|
| Python | ≥ 3.11 | Backend API server |
| Node.js | ≥ 20 | Frontend only |
| PostgreSQL | ≥ 14 | Storage + semantic search |
| pgvector extension | ≥ 0.5.0 | Vector similarity search (must be installed separately) |
| OpenRouter API key | — | All model inference (investigation, extraction, embeddings) |

**Installing pgvector** (required — PostgreSQL does not include it by default):

```bash
# macOS (Homebrew)
brew install pgvector

# Ubuntu / Debian
sudo apt install postgresql-16-pgvector   # replace 16 with your PG major version

# From source (any platform)
git clone https://github.com/pgvector/pgvector.git
cd pgvector && make && make install
```

---

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd foialens

# Frontend dependencies
npm install

# Backend dependencies
cd backend && pip install -r requirements.txt && cd ..
```

### 2. Environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and fill in the required values:

```env
# OpenRouter — all model inference (get key at https://openrouter.ai/keys)
OPENROUTER_API_KEY=sk-or-...

# Postgres connection string
DATABASE_URL=postgresql://user:password@localhost:5432/foialens

# Optional: change the default models
# OPENROUTER_MODEL=google/gemini-flash-1.5
# OPENROUTER_EXTRACT_MODEL=google/gemini-flash-1.5
```

### 3. Database setup

```bash
createdb foialens
psql foialens < lib/db/schema.sql
```

### 4. Run both servers

In one terminal — Python backend (port 8000):

```bash
cd backend
uvicorn main:app --reload --port 8000
```

In another terminal — Next.js frontend (port 3000):

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The frontend calls the Python backend at `http://localhost:8000/api/`.

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
# From the project root
npm run seed
```

Ingests a sample public-domain FOIA release and opens a workspace in the browser.

---

## Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Backend | FastAPI + uvicorn (Python 3.11+) | Async, native SSE streaming, clean routing |
| Frontend | Next.js 14 (App Router) + TypeScript | React server components, file-based routing |
| Database | PostgreSQL + pgvector | Relational + semantic search in one store |
| Agent | `google/gemini-flash-1.5` via OpenRouter | Tool use + long-context reasoning |
| Extraction | `google/gemini-flash-1.5` via OpenRouter | Structured entity/timeline extraction |
| Embeddings | `openai/text-embedding-3-small` via OpenRouter | Best cost/quality for semantic retrieval |
| PDF parsing | pdfplumber | Page-level text extraction with layout awareness |
| Styling | Tailwind CSS | Utility-first, no build-step CSS |

---

## Project structure

```
foialens/
├── backend/                                   # Python — FastAPI server (port 8000)
│   ├── main.py                                # App init, CORS, router registration
│   ├── requirements.txt
│   ├── db/
│   │   └── client.py                          # asyncpg connection pool
│   ├── ingestion/
│   │   ├── pdf_extractor.py                   # pdfplumber → PagedText[]
│   │   ├── chunker.py                         # Sentence-aware chunking with overlap
│   │   ├── embedder.py                        # OpenAI text-embedding-3-small
│   │   └── upload.py                          # Orchestrates extract → chunk → embed → store
│   ├── tools/
│   │   ├── __init__.py                        # TOOL_DEFINITIONS + dispatch_tool()
│   │   ├── search_documents.py
│   │   ├── extract_entities.py
│   │   ├── build_timeline.py
│   │   ├── propose_angle.py
│   │   └── haiku_utils.py                     # Shared Haiku client + JSON parsing
│   ├── agent/
│   │   ├── investigator.py                    # Async generator tool-use loop
│   │   └── prompts.py                         # WorkspaceContext + system/user prompts
│   └── routers/
│       ├── workspaces.py                      # POST /workspaces, POST /workspaces/{id}/upload
│       ├── investigate.py                     # POST /investigate — SSE stream
│       ├── angles.py                          # PATCH /angles/{id}
│       └── runs.py                            # GET /runs/{id}
├── app/                                       # Next.js frontend (port 3000)
│   ├── layout.tsx
│   ├── page.tsx                               # Home — list workspaces, create new
│   ├── globals.css
│   └── workspace/[workspaceId]/
│       └── page.tsx                           # Investigation workspace
├── components/
│   ├── WorkspaceBoard.tsx                     # Angle card grid + triage controls
│   ├── AngleCard.tsx                          # Single angle with evidence
│   ├── UploadZone.tsx
│   ├── InvestigatePanel.tsx                   # Mode selector + prompt input
│   ├── AgentTrace.tsx                         # Collapsible reasoning trace
│   ├── EntityMap.tsx                          # Accumulated entity list
│   └── Timeline.tsx                           # Accumulated timeline
├── lib/
│   └── db/
│       └── schema.sql                         # Shared PostgreSQL schema
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

- No collaborative editing — workspaces are single-user. Angles are not shared or commented on in real time.
- Investigation runs within a workspace are sequential; starting a second run while one is in progress is rejected.
