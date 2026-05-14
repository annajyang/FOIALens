# FOIALens — Technical Specification

## 1. System overview

FOIALens is built around a **workspace** metaphor. A workspace is a named, persistent investigation environment tied to a document corpus. Journalists run any number of investigation passes — exploratory or directed — against the same corpus, and each pass adds to the workspace's growing collection of story angles, entities, and timeline events.

```
┌───────────────────────────────────────────────────────────────────────┐
│  WORKSPACE  (persistent, named, many investigation runs)              │
│                                                                       │
│  ┌────────────┐   ┌─────────────────────────────────────────────┐    │
│  │  CORPUS    │   │  INVESTIGATION RUN                          │    │
│  │            │   │                                             │    │
│  │  PDF → text│   │  mode: exploratory | directed               │    │
│  │  → chunks  │   │  prompt: optional focus question            │    │
│  │  → vectors │   │                                             │    │
│  │  (pgvector)│   │  Agent Loop (Claude Sonnet)                 │    │
│  │            │◀──│    ├── search_documents(query)              │    │
│  │            │   │    ├── extract_entities(scope)              │    │
│  │            │   │    ├── build_timeline()                     │    │
│  │            │   │    └── propose_angle(title, summary, ...)   │    │
│  └────────────┘   │                          │                  │    │
│                   └──────────────────────────┼──────────────────┘    │
│                                              │ SSE stream             │
│  ┌───────────────────────────────────────────▼──────────────────┐    │
│  │  ANGLES  (accumulate across runs, journalist-curated)        │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │    │
│  │  │ proposed     │  │ pinned       │  │ dismissed    │       │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌───────────────────┐  ┌─────────────────────────────────────────┐  │
│  │  ENTITY MAP       │  │  TIMELINE                               │  │
│  │  (merged across   │  │  (merged across runs, deduplicated)     │  │
│  │   all runs)       │  └─────────────────────────────────────────┘  │
│  └───────────────────┘                                               │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 2. Investigation modes

The same agent loop handles both modes. The mode determines the system prompt and the agent's search strategy.

### Exploratory mode

Used when the journalist has no specific hypothesis. The agent approaches the corpus as an editor would approach a new document dump: scan broadly, identify patterns and anomalies, and surface distinct story opportunities.

**Agent behavior in exploratory mode:**
- Runs 6–10 varied semantic searches to get broad coverage (not just one entry point)
- Actively looks for: unusual financial flows, gaps in the record, named individuals with unclear roles, discrepancies between dates or amounts, and anything that contradicts an official narrative
- Targets 4–8 distinct angles — each should be a *different* story, not variations on the same theme
- Ranks angles by newsworthiness before proposing them

**Exploratory system prompt (summarized):**
```
You are a senior investigative editor reviewing a new FOIA document dump.
You have no prior hypothesis. Your job is to find every potentially newsworthy
angle in this corpus — things that would surprise readers, contradict official
accounts, reveal hidden relationships, or show misuse of public resources.

Be skeptical and systematic. Cast a wide net before narrowing. Propose each
distinct story angle you identify using propose_angle. Angles should be
meaningfully different from each other — not variations on the same theme.

Minimum 4 angles, maximum 8. Rank by newsworthiness. Cite every claim.
```

### Directed mode

Used when the journalist has a specific question or lead to pursue. The agent focuses on building or refuting that specific case.

**Agent behavior in directed mode:**
- Treats the journalist's prompt as the primary investigative goal
- Searches specifically for evidence supporting, complicating, or contradicting the goal
- Still surfaces related angles that emerge from the search — a good document dump rarely contains just one story
- More depth, fewer angles (typically 2–4)

**Directed system prompt (summarized):**
```
You are an investigative researcher working on a specific lead:

"{prompt}"

Your job is to find everything in this corpus that bears on this question:
evidence that supports it, evidence that contradicts it, key figures involved,
and the timeline of relevant events. Be rigorous — distinguish what the
documents actually say from what they imply.

Propose your findings as story angles using propose_angle. Lead with the
angle most directly addressing the journalist's goal. Include any significant
related angles you discover. Cite every claim with page numbers.
```

---

## 3. Ingestion pipeline

### 3.1 PDF text extraction (`backend/ingestion/pdf_extractor.py`)

Uses `pdfplumber` to extract text with page-number metadata. Each page is returned as a `PagedText` dataclass:

```python
@dataclass
class PagedText:
    page: int
    text: str
```

The extractor rejoins hyphenated line breaks, strips form-feed characters, and normalises excessive whitespace.

### 3.2 Chunking strategy (`backend/ingestion/chunker.py`)

**Goal:** ~500 tokens per chunk, no mid-sentence breaks, with 50-token overlap between adjacent chunks.

**Algorithm:**

1. Tokenize roughly by character count (1 token ≈ 4 chars → target ~2000 chars).
2. Split candidate chunks on sentence boundaries using a regex that detects `.`, `?`, `!` followed by whitespace or end-of-string. Abbreviations (U.S., Dr., etc.) are handled by a denylist of common prefixes.
3. Append the last 200 characters of chunk N as a prefix to chunk N+1 to preserve cross-chunk context.

Each chunk is tagged with the originating page number range:

```python
@dataclass
class RawChunk:
    content: str
    start_page: int
    end_page: int
    chunk_index: int
    token_count: int  # approximate: chars / 4
```

### 3.3 Embedding (`backend/ingestion/embedder.py`)

- Model: `text-embedding-3-small` (OpenAI), output dimension: **1536**.
- Chunks are batched in groups of 100 before calling the embedding API to minimise round-trips.
- Embeddings are stored as pgvector `vector(1536)` columns, passed as `[x,y,...]` strings with a `::vector` cast.

### 3.4 Upload orchestrator (`backend/ingestion/upload.py`)

```
ingest_files(files, workspace_id) →
  for each file:
    1. extract_pages(buffer) → list[PagedText]
    2. chunk_pages(pages)    → list[RawChunk]
    3. embed_texts(contents) → list[list[float]]
    4. INSERT document row
    5. INSERT chunk rows (within a single transaction)
  UPDATE workspace status → 'ready'
```

---

## 4. Tool suite (`backend/tools/`)

Tools are defined in the Anthropic tool-use schema and dispatched by the agent loop. Each tool is a Python async function that reads from the database or makes a secondary Claude call.

### `search_documents(query: string, limit?: number)`

**Purpose:** Semantic search over all chunks in the workspace.

**Implementation:**
1. Embed the query using `text-embedding-3-small`.
2. Run `SELECT ... ORDER BY embedding <=> $1 LIMIT $2` (cosine distance, pgvector operator).
3. Return the top results with content, page range, document name, and similarity score.

**Returns:**
```ts
{
  results: Array<{
    content: string;
    startPage: number;
    endPage: number;
    documentName: string;
    similarity: number;   // 0–1, higher is closer
  }>;
}
```

---

### `extract_entities(scope?: "full" | { documentId: string })`

**Purpose:** Pull people, organizations, dates, and dollar amounts from the corpus or a specific document.

**Implementation:**
A targeted Claude Haiku call over the relevant chunks with a structured extraction prompt. Haiku (not Sonnet) keeps per-tool cost low. Returns JSON validated against the entity schema. Results are merged with any entities already extracted in this run to avoid duplicates.

**Returns:**
```ts
{
  entities: Array<{
    name: string;
    type: "person" | "organization" | "date" | "amount" | "location";
    mentions: number;
    pageRefs: number[];
    representativeContext: string;
  }>;
  newCount: number;   // entities not seen in previous extractions this run
}
```

---

### `build_timeline()`

**Purpose:** Reconstruct a chronology of events by scanning for dated references.

**Implementation:**
1. Calls `search_documents` internally with queries targeting date-bearing language: `"signed", "approved", "meeting", "agreement", "effective date"`.
2. A Haiku call extracts (date, event, significance) tuples from the returned chunks.
3. Results are sorted chronologically. Ambiguous relative dates ("last Tuesday") are flagged with `confidence: "low"` and not resolved.

**Returns:**
```ts
{
  events: Array<{
    date: string;           // ISO 8601, or "circa YYYY" for approximations
    description: string;
    significance: string;
    pageRefs: number[];
    confidence: "high" | "medium" | "low";
  }>;
}
```

---

### `propose_angle(title, summary, newsworthiness, evidence, citations)`

**Purpose:** The agent uses this to register a story angle as it discovers it. This is the primary output mechanism — each call creates an `angle` row in the database and emits an SSE event so the angle card appears on the workspace board in real time.

This tool exists because angles are first-class objects that the journalist interacts with (triage, pin, dismiss). The agent does not save them as a batch at the end; it proposes each one as soon as it has enough evidence.

**Input:**
```ts
{
  title: string;            // working headline, ~8 words
  summary: string;          // 2–3 sentence newsworthiness summary
  newsworthiness: "high" | "medium" | "low";
  angleType: "financial" | "personnel" | "timeline" | "contradiction"
             | "omission" | "relationship" | "other";
  evidence: string[];       // key supporting facts with inline (p. N) citations
  citations: Array<{
    page: number;
    excerpt: string;        // verbatim text from the document
  }>;
}
```

**Returns:**
```ts
{
  angleId: string;          // UUID — agent can reference it in the final memo
  accepted: true;
}
```

**SSE effect:** emits `{ type: "angle_proposed", angle: { id, title, summary, ... } }` immediately when called, so the card appears on the board before the investigation finishes.

---

## 5. Agentic loop (`backend/agent/investigator.py`)

### 5.1 Loop design

Standard Claude tool-use conversation loop implemented as a Python **async generator** — it `yield`s SSE event dicts that the FastAPI route streams to the client. The mode-appropriate system prompt and a workspace context block are injected before the user turn.

```python
messages = [
  {"role": "user", "content": build_user_turn(workspace_context)}
]

async for _ in range(MAX_ITERATIONS):
  response = await anthropic.messages.create(
      model=SONNET, max_tokens=8192,
      system=build_system_prompt(mode, prompt),
      tools=TOOL_DEFINITIONS, messages=messages,
  )
  messages.append({"role": "assistant", "content": response.content})

  if response.stop_reason == "end_turn":
    yield {"type": "done", ...}
    return

  if response.stop_reason == "tool_use":
    tool_results = []
    for block in response.content:
      if block.type != "tool_use": continue
      result = await dispatch_tool(block.name, block.input, workspace_id, run_id)
      yield {"type": "trace", "tool": block.name, ...}
      tool_results.append({"type": "tool_result",
                           "tool_use_id": block.id, "content": json.dumps(result)})
    messages.append({"role": "user", "content": tool_results})
```

### 5.2 Workspace context block

Injected as part of the user turn before the agent starts. Gives the agent situational awareness:

```
Workspace: "{workspaceName}"
Documents: report_2023.pdf (142 pp.), appendix_a.pdf (28 pp.)
Total chunks indexed: 312
Prior investigation runs: 1 (exploratory, 2025-07-30 — 5 angles proposed)
Previously pinned angles: "No-bid contract to Acme Corp bypassed procurement rules"
```

This prevents the agent from re-proposing angles the journalist has already triaged and focuses subsequent directed runs on unexplored territory.

### 5.3 Across-run accumulation

Each workspace maintains a merged entity map and timeline that grows across runs. When `extract_entities` or `build_timeline` runs:
1. New results are compared against the workspace's existing accumulated data.
2. New entities/events are appended; duplicates (matched by name normalization) are merged.
3. The accumulated state is returned to the caller via `GET /api/workspaces/[workspaceId]`.

### 5.4 SSE event types

| Event | When | Payload |
|---|---|---|
| `status` | Start of run, before each tool call | `{ message: string }` |
| `trace` | After each tool result is received | `{ tool, input, resultSummary, timestamp }` |
| `angle_proposed` | When agent calls `propose_angle` | `{ angle: Angle }` |
| `done` | Run complete | `{ runId, summary, entityCount, eventCount }` |
| `error` | Failure mid-stream | `{ message: string }` |

---

## 6. Frontend workspace layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  FOIALens  /  City Hall Contracts 2019–2023          [+ Add docs]   │
├────────────────┬─────────────────────────────────────────────────────┤
│                │                                                     │
│  INVESTIGATE   │  STORY ANGLES              [Pinned ▲]  [All] [New]  │
│                │                                                     │
│  ○ Explore     │  ┌──────────────────┐  ┌──────────────────┐        │
│  ● Directed    │  │ ★ PINNED         │  │ ★ PINNED         │        │
│                │  │ No-bid contract  │  │ $4.1M in fees    │        │
│  [Focus prompt]│  │ to Acme Corp     │  │ with no receipts │        │
│                │  │ bypassed rules   │  │                  │        │
│  [Investigate] │  │ HIGH · financial │  │ HIGH · financial │        │
│                │  │ p.14, 31, 88     │  │ p.22, 47         │        │
│  ─────────────│  │ [Expand] [Pin ★] │  │ [Expand] [Pin ★] │        │
│                │  └──────────────────┘  └──────────────────┘        │
│  CORPUS        │                                                     │
│  report_2023   │  ┌──────────────────┐  ┌──────────────────┐        │
│  appendix_a    │  │   PROPOSED       │  │   PROPOSED       │        │
│  [+ Add]       │  │ Deputy director  │  │ Bid timeline     │        │
│                │  │ had conflict of  │  │ inconsistencies  │        │
│  ─────────────│  │ interest         │  │ in 2021          │        │
│                │  │ MEDIUM · person  │  │ LOW · timeline   │        │
│  ENTITIES  ›   │  │ p.56, 71         │  │ p.103            │        │
│  TIMELINE  ›   │  │ [Pin] [Dismiss]  │  │ [Pin] [Dismiss]  │        │
│  TRACE     ›   │  └──────────────────┘  └──────────────────┘        │
│                │                                                     │
└────────────────┴─────────────────────────────────────────────────────┘
```

The left panel is always visible and provides: investigation controls, corpus file list, and collapsible panels for entities, timeline, and agent trace. The main area is the angle board — a masonry grid of angle cards that builds up in real time as the agent runs.

---

## 7. Key design decisions

### Why angles instead of a single report?

Journalism is rarely one story. A 500-page FOIA dump almost always contains multiple independent stories at different stages of strength. Collapsing everything into one report forces the journalist to extract angles themselves. Making angles first-class lets the tool do that disaggregation and lets the journalist triage rather than read.

### Why is `propose_angle` a tool the agent calls, not a post-processing step?

Post-processing the agent's final text to extract angles is fragile — it requires parsing natural language, which introduces errors. Making angle proposal a tool call means each angle arrives as structured data with a defined schema. It also allows angles to appear on the board in real time as the agent discovers them, rather than all at once at the end. The streaming UX depends on this.

### Why pgvector instead of a dedicated vector DB?

Keeping documents, metadata, and embeddings in a single Postgres instance simplifies deployment and enables hybrid queries — e.g., `WHERE workspace_id = $1 ORDER BY embedding <=> $2`. For the scale of a typical FOIA dump (< 100k chunks), pgvector's IVFFlat index is more than sufficient.

### Why sentence-aware chunking with overlap?

Mid-sentence splits produce semantically incomplete chunks, degrading embedding quality and retrieval. The 50-token overlap ensures sentences spanning a chunk boundary appear in at least one retrievable unit. The 500-token target balances retrieval precision against context richness.

### Why Haiku for entity extraction and timeline, Sonnet for the loop?

Entity extraction and timeline building are structured extraction tasks over bounded text — Haiku handles them accurately and costs 10× less than Sonnet. The multi-step reasoning loop (deciding what to search, how to connect findings, what constitutes a distinct angle) requires Sonnet's stronger reasoning.

### Why multiple investigation runs instead of one long one?

Investigative journalism is iterative. The journalist needs to read the first wave of findings, decide what to chase, and then go deeper. A single mega-run would be slow, expensive, and would front-load all work without giving the journalist a chance to steer. Multiple short runs (15–25 tool calls each) keep the loop fast and responsive to journalist input.
