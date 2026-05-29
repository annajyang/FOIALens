# FoiaLens — Video Notes

## How the Product Works

**High-level flow:**
- User creates a workspace, uploads PDF documents (FOIA releases, government records, court filings)
- Documents are processed through an ingestion pipeline: text extraction → chunking → embedding → stored in PostgreSQL with pgvector
- User runs an "investigation" — an AI agent iteratively searches the corpus, extracts entities and timeline events, and proposes newsworthy story angles
- User pins angles they find interesting, then opens a chat thread to dig deeper with inline citations that link back to the exact PDF page

**Ingestion pipeline:**
- PDFs are parsed with pdfplumber for native text; falls back to vision-based OCR (Gemini Flash) for scanned documents
- Text is chunked into ~2000-character segments with 200-character overlap to preserve context across chunk boundaries
- Each chunk is embedded using OpenAI's text-embedding-3-small and stored as a 1024-dimension vector in PostgreSQL

**Agent loop:**
- Powered by Gemini 3.5 flash (can also config any model via OpenRouter, but that was cheapest) with a multi-turn tool-use loop capped at 10 iterations
- Tools available to the agent: `search_documents` (hybrid semantic + keyword search), `extract_entities`, `build_timeline`, `propose_angle`
- Hybrid retrieval fuses vector similarity and full-text keyword search using Reciprocal Rank Fusion (RRF) — better than either alone
- Streaming via Server-Sent Events (SSE) lets the user watch the investigation unfold in real time

**Deployment:**
- Backend: Python/FastAPI; Frontend: Next.js (TypeScript)
- Database: PostgreSQL with the pgvector extension for similarity search
- Optional cloud storage: DigitalOcean Spaces (S3-compatible) for raw PDF files
- Auth: magic-link email sign-in; guest access available without sign-in (workspaces expire in 7 days)
- Hosted on DigitalOcean App Platform

---

## Potential Use Cases

- **Investigative journalism** — the core use case; analyze large FOIA document dumps for leads without reading every page
- **Legal document review** — surface patterns, contradictions, and key entities across contracts, filings, or discovery documents
- **Policy research** — quickly extract timelines and key actors from government reports or committee minutes
- **Academic research** — mine primary source documents (historical records, archives) for entities and chronologies
- **Nonprofit accountability work** — analyze public records about government spending, environmental violations, or civil rights issues
- **Local journalism** — small newsrooms with limited staff can process public records requests they would otherwise lack capacity to analyze

---

## Impact & Value to Society

- FOIA requests generate enormous volumes of documents — agencies sometimes release thousands of pages at once, making it impractical for a single journalist to read everything
- Most newsrooms do not have data teams; FoiaLens puts document intelligence tools in the hands of any reporter
- Reduces time-to-story: what might take a journalist weeks of reading can be surfaced in minutes
- Citations are grounded — every agent claim links to a specific page, so journalists can verify and trace every finding back to the primary source
- Supports accountability journalism that holds institutions — government, corporations, universities — responsible to the public
- Democratizes investigative capacity: a freelance journalist or small outlet can now process the same document volumes as a large newsroom with dedicated researchers

---

## How People Would Use This

- A reporter receives a 3,000-page FOIA release, uploads it to FoiaLens, runs an exploratory investigation, and gets a ranked list of angles within minutes — financial irregularities, personnel connections, timeline gaps — each backed by cited page references
- A local journalist covering city council uploads meeting minutes and budget documents, then asks directed questions: "Did the city approve any contracts with vendors connected to council members?"
- An editor at a nonprofit newsroom uses the entities view to map relationships between people named across multiple document releases
- A journalism student uses the demo files to practice reading primary source documents with AI assistance, learning to trace claims back to sources

---

## Why We Built What We Built

- **RAG over raw chat:** Feeding full documents into an LLM context window is expensive, hits context limits fast, and doesn't scale to large corpora — RAG lets us search only the relevant chunks
- **Hybrid search (not just semantic):** Pure vector search misses exact keyword matches (proper names, dates, dollar amounts); pure keyword search misses paraphrases; RRF fusion gives the best of both
- **Streaming iterative agent, not one-shot:** A multi-turn tool-use loop lets the agent gather evidence across multiple searches before drawing conclusions — closer to how a journalist actually reads
- **Citation-first design:** Without citations, AI answers are unverifiable and dangerous for journalism; every response must link to a source page
- **OpenRouter for model flexibility:** Investigation quality depends heavily on model capability; abstracting behind OpenRouter lets us swap models without touching code

---

## Bottlenecks Identified

- **Ingestion latency:** Processing large PDF sets is slow — text extraction, chunking, and embedding each add latency; OCR on scanned documents is especially slow (one LLM call per page)
- **Context window vs. corpus size:** The agent can only read so many chunks per turn; large corpora require careful retrieval to surface the right evidence without exceeding token limits
- **Entity deduplication:** The same person or organization can appear under many name variants; simple lowercase dedup misses aliases, abbreviations, and typos
- **Angle quality vs. quantity:** Without careful prompting, the agent either proposes too many shallow angles or converges too quickly on obvious findings; nudging logic is a workaround, not a real solution
- **Cost at scale:** Running a full investigation against a large corpus is not cheap; cost-per-investigation increases with document count and model capability
- **No cross-workspace knowledge:** Entities and timelines are scoped to a single workspace — a journalist covering the same institution across multiple FOIA releases must manually connect findings

---

## What Inspired This

- FOIA journalism is one of the most resource-intensive forms of accountability reporting — it requires both the legal knowledge to file requests and the capacity to analyze what comes back
- High-profile examples (Panama Papers, Epstein documents, Pentagon Papers) show that released document sets can contain explosive information buried in thousands of pages
- Existing tools (DocumentCloud, PACER) help with storage and basic search but don't synthesize or propose angles
- The combination of cheap embedding models, capable instruction-following LLMs, and pgvector made a full RAG-powered investigation pipeline feasible to build

---

## What We'd Add Next

- **Cross-workspace entity linking** — connect people and organizations across multiple FOIA releases or investigations
- **Contradiction detection** — explicitly flag where documents contradict each other (conflicting accounts, inconsistent figures)
- **Collaborative workspaces** — multiple journalists working the same document set simultaneously
- **Export to story draft** — turn a pinned angle and its evidence into a structured story outline
- **Document comparison** — diff two versions of the same document (e.g. redacted vs. less-redacted release)
- **FOIA request assistant** — suggest & send follow-up FOIA requests based on gaps the agent identifies
- **Better OCR pipeline** — batch scanned pages, cache results, reduce per-page cost