# FOIALens — API Specification

All endpoints live under `/app/api/`. All request and response bodies are `application/json` unless noted.

---

## Workspaces

### `GET /api/workspaces`

List all workspaces (home page).

#### Response — `200 OK`

```json
{
  "workspaces": [
    {
      "id": "3f2a1b4c-...",
      "name": "City Hall Contracts 2019–2023",
      "status": "active",
      "documentCount": 3,
      "angleCount": 7,
      "pinnedCount": 2,
      "lastRunAt": "2025-08-01T14:24:15Z",
      "createdAt": "2025-08-01T14:20:00Z"
    }
  ]
}
```

---

### `POST /api/workspaces`

Create a new workspace and ingest documents. Single endpoint — workspace creation and initial upload happen together.

#### Request

`Content-Type: multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Workspace name. Max 100 chars. |
| `files` | `File[]` | Yes | PDF files. Max 50 MB each, max 20 files. |

#### Response — `201 Created`

Returned after ingestion completes (synchronous).

```json
{
  "workspaceId": "3f2a1b4c-...",
  "status": "ready",
  "documentCount": 3,
  "chunkCount": 312
}
```

#### Error responses

| Status | Code | When |
|---|---|---|
| `400` | `MISSING_NAME` | No name field |
| `400` | `NO_FILES` | No files in request |
| `400` | `TOO_MANY_FILES` | More than 20 files |
| `400` | `FILE_TOO_LARGE` | Any file exceeds 50 MB |
| `400` | `INVALID_TYPE` | A file is not a PDF |
| `500` | `EXTRACTION_FAILED` | pdf-parse error |
| `500` | `DB_ERROR` | Postgres write failure |

---

### `GET /api/workspaces/[workspaceId]`

Full workspace detail: documents, all angles (with status), accumulated entities, timeline, and run history.

#### Response — `200 OK`

```json
{
  "workspace": {
    "id": "3f2a1b4c-...",
    "name": "City Hall Contracts 2019–2023",
    "status": "active",
    "documents": [
      { "id": "...", "filename": "report_2023.pdf", "pageCount": 142, "byteSize": 4200000 }
    ],
    "chunkCount": 312,
    "angles": [
      {
        "id": "a1b2c3-...",
        "runId": "r9e8d7-...",
        "title": "No-bid contract to Acme Corp bypassed procurement rules",
        "summary": "Documents show the city awarded a $2.3M contract to Acme Corp in 2021 without competitive bidding. Internal memos show the deputy director overrode the standard review process.",
        "newsworthiness": "high",
        "angleType": "financial",
        "evidence": [
          "Acme Corp awarded $2.3M contract March 2021 without bidding (p.14)",
          "Deputy director signed waiver exempting contract from standard review (p.31)",
          "Acme Corp donated $15,000 to mayor's campaign in November 2020 (p.88)"
        ],
        "citations": [
          { "page": 14, "excerpt": "Contract #2021-447 awarded to Acme Corp, $2,300,000, single-source justification attached" },
          { "page": 31, "excerpt": "Waiver of competitive bidding requirement authorized by Deputy Director R. Walsh, 3/12/2021" }
        ],
        "status": "pinned",
        "createdAt": "2025-08-01T14:23:44Z"
      }
    ],
    "entities": [ ... ],
    "timeline": [ ... ],
    "runs": [
      {
        "id": "r9e8d7-...",
        "mode": "exploratory",
        "prompt": null,
        "status": "done",
        "startedAt": "2025-08-01T14:21:00Z",
        "completedAt": "2025-08-01T14:24:15Z"
      }
    ],
    "createdAt": "2025-08-01T14:20:00Z",
    "updatedAt": "2025-08-01T14:24:15Z"
  }
}
```

#### Error responses

| Status | Code | When |
|---|---|---|
| `404` | `WORKSPACE_NOT_FOUND` | No workspace with that ID |
| `500` | `DB_ERROR` | Postgres read failure |

---

### `PATCH /api/workspaces/[workspaceId]`

Update workspace metadata (currently: rename).

#### Request

```json
{ "name": "City Hall No-Bid Contracts" }
```

#### Response — `200 OK`

```json
{ "id": "3f2a1b4c-...", "name": "City Hall No-Bid Contracts" }
```

---

### `POST /api/workspaces/[workspaceId]/upload`

Add more documents to an existing workspace. Only allowed when status is `ready` or `active` (not while a run is in progress).

#### Request

`Content-Type: multipart/form-data`

| Field | Type | Required |
|---|---|---|
| `files` | `File[]` | Yes |

#### Response — `200 OK`

```json
{
  "addedDocuments": 2,
  "addedChunks": 87,
  "totalChunks": 399
}
```

#### Error responses

| Status | Code | When |
|---|---|---|
| `409` | `RUN_IN_PROGRESS` | Cannot add documents while a run is active |

---

## Investigations

### `POST /api/investigate`

Trigger a new investigation run against a workspace. Returns a **Server-Sent Events stream**.

#### Request

```json
{
  "workspaceId": "3f2a1b4c-...",
  "mode": "exploratory",
  "prompt": null
}
```

```json
{
  "workspaceId": "3f2a1b4c-...",
  "mode": "directed",
  "prompt": "Who authorized the no-bid contracts to Acme Corp and when?"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `workspaceId` | `string` | Yes | |
| `mode` | `"exploratory" \| "directed"` | Yes | |
| `prompt` | `string \| null` | No | Required if mode is `directed`; ignored if `exploratory` |

#### Response — `200 OK` — `text/event-stream`

Events are emitted as newline-delimited `data:` lines.

**`status`** — progress updates

```
data: {"type":"status","message":"Starting exploratory scan…"}
```

**`trace`** — emitted after each tool call resolves

```
data: {
  "type": "trace",
  "tool": "search_documents",
  "input": { "query": "no-bid contract single source" },
  "resultSummary": "8 chunks found. Top: p.14 — 'Contract #2021-447 awarded to Acme Corp, single-source justification…'",
  "timestamp": "2025-08-01T14:23:01Z"
}
```

**`angle_proposed`** — emitted immediately when the agent calls `propose_angle`. The angle card should appear on the board at this moment without waiting for the run to finish.

```
data: {
  "type": "angle_proposed",
  "angle": {
    "id": "a1b2c3-...",
    "title": "No-bid contract to Acme Corp bypassed procurement rules",
    "summary": "Documents show the city awarded a $2.3M contract...",
    "newsworthiness": "high",
    "angleType": "financial",
    "evidence": ["Acme Corp awarded $2.3M contract March 2021 (p.14)", "..."],
    "citations": [{ "page": 14, "excerpt": "..." }],
    "status": "proposed",
    "createdAt": "2025-08-01T14:23:44Z"
  }
}
```

**`done`** — run complete

```
data: {
  "type": "done",
  "runId": "r9e8d7-...",
  "summary": "This exploratory scan identified 5 story angles...",
  "angleCount": 5,
  "newEntityCount": 14,
  "newTimelineEventCount": 8
}
```

**`error`** — failure mid-stream

```
data: {"type":"error","message":"Claude API rate limit. Retry after 60s."}
```

#### Pre-stream error responses (standard JSON)

| Status | Code | When |
|---|---|---|
| `400` | `MISSING_WORKSPACE_ID` | No workspaceId in body |
| `400` | `INVALID_MODE` | Mode is not `exploratory` or `directed` |
| `400` | `PROMPT_REQUIRED` | Directed mode with no prompt |
| `404` | `WORKSPACE_NOT_FOUND` | No workspace with that ID |
| `409` | `NOT_READY` | Workspace is still ingesting |
| `409` | `RUN_IN_PROGRESS` | Another run is active on this workspace |
| `500` | `ANTHROPIC_ERROR` | Claude API non-retryable error |

#### Behavior

- Sets workspace status to `investigating` before stream opens.
- Creates an `investigation_runs` row with status `investigating`.
- Angles are written to the DB immediately when the agent calls `propose_angle` — they are not batched at the end.
- On `done`: updates the run to `done`, merges new entities/timeline into the workspace, sets workspace status to `active`.
- On `error`: sets run status to `error`, sets `run.error`, resets workspace status to `active` (or `ready` if this was the first run).
- Stream is not resumable. If the client disconnects, the agent continues server-side; retrieve the run's angles via `GET /api/workspaces/[workspaceId]`.

#### Client consumption example

```ts
const res = await fetch("/api/investigate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspaceId, mode: "exploratory" }),
});

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop()!;  // keep incomplete line in buffer

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "angle_proposed") addAngleCard(event.angle);
    if (event.type === "trace")          appendTrace(event);
    if (event.type === "done")           markRunComplete(event);
    if (event.type === "error")          showError(event.message);
  }
}
```

---

## Angles

### `PATCH /api/angles/[angleId]`

Update the status of an angle (journalist triage action). Only `status` is mutable after creation.

#### Request

```json
{ "status": "pinned" }
```

Valid values: `"proposed"`, `"pinned"`, `"dismissed"`.

#### Response — `200 OK`

```json
{
  "id": "a1b2c3-...",
  "status": "pinned",
  "updatedAt": "2025-08-01T15:02:00Z"
}
```

#### Error responses

| Status | Code | When |
|---|---|---|
| `400` | `INVALID_STATUS` | Status is not a valid value |
| `404` | `ANGLE_NOT_FOUND` | No angle with that ID |

---

## Investigation runs

### `GET /api/runs/[runId]`

Fetch a specific run's full trace and summary. Used to restore the trace panel if the client reconnected after the stream ended.

#### Response — `200 OK`

```json
{
  "run": {
    "id": "r9e8d7-...",
    "workspaceId": "3f2a1b4c-...",
    "mode": "exploratory",
    "prompt": null,
    "status": "done",
    "summary": "This exploratory scan of 312 document chunks identified 5 story angles…",
    "trace": [
      {
        "type": "tool_call",
        "tool": "search_documents",
        "input": { "query": "contractor payments 2021" },
        "resultSummary": "8 results found…",
        "timestamp": "2025-08-01T14:23:01Z"
      }
    ],
    "error": null,
    "startedAt": "2025-08-01T14:21:00Z",
    "completedAt": "2025-08-01T14:24:15Z"
  }
}
```

---

## Common error envelope

All non-stream error responses:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable explanation."
}
```

---

## Timeouts

| Endpoint | Timeout | Notes |
|---|---|---|
| `POST /api/workspaces` (upload) | 120 s | Embedding latency × batch count |
| `POST /api/workspaces/[id]/upload` | 120 s | Same |
| `POST /api/investigate` | 300 s | Agent loop |
| All other endpoints | 10 s | Simple reads/writes |

Set in each route file:

```ts
export const maxDuration = 300; // Vercel Pro/Enterprise; no limit in local dev
```
