'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { setOwnerEmail, setAuthToken } from '../../../lib/session';
import type { WorkspaceDetail, Angle, AngleStatus, SSEEvent, TraceEntry, Document } from '../../../lib/types';
import UploadZone from '../../../components/UploadZone';
import ReactMarkdown from 'react-markdown';

type Tool = 'angles' | 'entities' | 'timeline' | 'trace';
type Tab  = 'pinned' | 'all';

interface ChatMsg {
  role: 'system' | 'user' | 'agent';
  content: string;
  ts: number;
  streaming?: boolean;
  quickReplies?: string[];
}

/* ── Follow-up question generation ────────────────────────────────────── */
function deriveFollowUps(angle: Angle): string[] {
  const byType: Record<string, string[]> = {
    financial: [
      'Who approved each of these transactions and what was their authority?',
      'Compare these amounts against comparable contracts at peer municipalities.',
      'Are there related payments or shell-company structures not yet identified?',
    ],
    personnel: [
      'What disclosure forms did this official file with the ethics commission?',
      'Pull all decisions where this person exercised procurement or budget authority.',
      'Who else in this official\'s network received city contracts?',
    ],
    timeline: [
      'Who was the clerk or official responsible for accepting each document?',
      'Request server logs or email metadata to verify exact submission timestamps.',
      'Are there other irregularities in this same procurement round?',
    ],
    contradiction: [
      'What is the official explanation for this discrepancy?',
      'Are there other documents in the corpus that corroborate or contradict this?',
      'What leads should be pursued based off this evidence?',
    ],
    omission: [
      'Who is responsible for the missing step and what is the standard process?',
      'Are there other gaps in this document trail?',
      'Who would have direct knowledge and could be interviewed?',
    ],
    relationship: [
      'Cross-reference these parties in state business and corporate registries.',
      'Who would have direct knowledge and could be interviewed?',
      'Are there other contracts involving these same parties?',
    ],
    other: [
      'What leads should be pursued based off this evidence?',
      'Who would have direct knowledge and could be interviewed?',
      'Are there other gaps in this document trail?',
    ],
  };
  return byType[angle.angleType] ?? byType.other;
}

/* ── Find doc by page ──────────────────────────────────────────────────── */
function findDocForPage(documents: Document[], page: number): Document | null {
  return documents.find(d => d.pageCount != null && d.pageCount >= page) ?? documents[0] ?? null;
}

/* ── Agent seed message with clickable evidence ────────────────────────── */
function buildAgentSeed(angle: Angle, documents: Document[]): string {
  const lines: string[] = [`I've reviewed the evidence on this angle.`, ''];

  if (angle.evidence.length > 0) {
    lines.push('**Evidence**');
    angle.evidence.forEach(ev => lines.push(`- ${ev}`));
    lines.push('');
  }

  if (angle.citations.length > 0) {
    const cites = angle.citations.map(c => {
      const doc = findDocForPage(documents, c.page);
      return doc ? `[${doc.filename}, p.${c.page}]` : `[p.${c.page}]`;
    });
    lines.push(`**Sources:** ${cites.join(' · ')}`);
    lines.push('');
  }

  lines.push('What would you like to dig into first?');
  return lines.join('\n');
}

/* ── Chat system prompt ────────────────────────────────────────────────── */
function buildChatSystem(angle: Angle, workspaceName: string, documents: Document[]): string {
  const docList = documents
    .map(d => `  • ${d.filename}${d.pageCount ? ` (${d.pageCount} pp.)` : ''}`)
    .join('\n');

  const lines = [
    `You are an investigative-journalism research assistant working on case: ${workspaceName}.`,
    `You are focused on a single story angle the reporter has pinned.`,
    `Always ground claims in the supplied evidence.`,
    `When citing a source you MUST use this EXACT format: [filename, p.N] — for example [contract_report.pdf, p.12].`,
    `Rules: (1) always include the document filename, (2) use "p." not "pp.", (3) cite only one page number per bracket — never ranges like "pp.1-2", (4) no other citation format is allowed.`,
    `Keep responses tight — 3–6 sentences unless asked for more.`,
    ``,
    `CORPUS DOCUMENTS:`,
    docList,
    ``,
    `ANGLE — ${angle.title}`,
    `Newsworthiness: ${angle.newsworthiness}  ·  Type: ${angle.angleType}`,
    ``,
    `SUMMARY:`,
    angle.summary,
    ``,
    `EVIDENCE:`,
    ...angle.evidence.map((e, i) => `  [${i + 1}] ${e}`),
    ``,
    `SOURCE PAGES:`,
    ...angle.citations.map(c => {
      const doc = findDocForPage(documents, c.page);
      const ref = doc ? `[${doc.filename}, p.${c.page}]` : `p.${c.page}`;
      return `  - ${ref}${c.excerpt ? `: "${c.excerpt.slice(0, 80)}…"` : ''}`;
    }),
  ];
  return lines.join('\n');
}

/* ── Main page ─────────────────────────────────────────────────────────── */
export default function WorkspacePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();

  const [workspace,   setWorkspace]   = useState<WorkspaceDetail | null>(null);
  const workspaceRef = useRef<WorkspaceDetail | null>(null);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  const [angles,      setAngles]      = useState<Angle[]>([]);
  const [trace,       setTrace]       = useState<TraceEntry[]>([]);
  const [running,     setRunning]     = useState(false);
  const [statusMsg,   setStatusMsg]   = useState<string | null>(null);
  const [runError,    setRunError]    = useState<string | null>(null);
  const [loadError,   setLoadError]   = useState<string | null>(null);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [tab,         setTab]         = useState<Tab>('all');
  const [tool,        setTool]        = useState<Tool>('angles');
  const [mode,        setMode]        = useState<'exploratory' | 'directed'>('exploratory');
  const [prompt,      setPrompt]      = useState('');
  const [suggestion,  setSuggestion]  = useState('');
  const [suggesting,  setSuggesting]  = useState(false);
  const [addDocsOpen, setAddDocsOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading,   setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmOpen,    setConfirmOpen]    = useState(false);
  const [deleteOpen,     setDeleteOpen]     = useState(false);
  const [deleting,       setDeleting]       = useState(false);
  const [deleteDocTarget, setDeleteDocTarget] = useState<{ id: string; filename: string } | null>(null);
  const [deletingDoc,    setDeletingDoc]    = useState(false);
  const [saveOpen,      setSaveOpen]      = useState(false);
  const [saveStep,      setSaveStep]      = useState<'email' | 'code'>('email');
  const [saveEmail,     setSaveEmail]     = useState('');
  const [saveCode,      setSaveCode]      = useState('');
  const [saving,        setSaving]        = useState(false);
  const [saveError,     setSaveError]     = useState<string | null>(null);

  const [corpusExpanded,   setCorpusExpanded]   = useState(false);
  const [extracting,       setExtracting]       = useState(false);
  const [extractError,     setExtractError]     = useState<string | null>(null);
  const [buildingTimeline, setBuildingTimeline] = useState(false);
  const [timelineError,    setTimelineError]    = useState<string | null>(null);

  // Doc viewer
  const [viewer, setViewer] = useState<{ open: boolean; doc: string | null; pages: number[]; focus: number }>({ open: false, doc: null, pages: [], focus: 1 });
  const openViewer = useCallback((docName: string, pages: number[], focus?: number) => {
    setViewer({ open: true, doc: docName, pages: pages || [], focus: focus ?? pages?.[0] ?? 1 });
  }, []);
  const closeViewer = useCallback(() => setViewer(v => ({ ...v, open: false })), []);

  // Chat threads — keyed by angleId
  const [chatThreads, setChatThreads] = useState<Record<string, ChatMsg[]>>({});
  const [openChatIds,  setOpenChatIds]  = useState<string[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatMinimized, setChatMinimized] = useState(false);
  const [chatDraft,    setChatDraft]    = useState('');

  const chatStorageKey = `foialens-chats-${workspaceId}-v1`;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(chatStorageKey) || '{}');
      if (Object.keys(saved).length > 0) {
        setChatThreads(saved);
        setOpenChatIds(Object.keys(saved));
        setActiveChatId(Object.keys(saved)[0]);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(chatStorageKey, JSON.stringify(chatThreads)); } catch {}
  }, [chatThreads]);

  const openChat = useCallback((angleId: string, draft?: string) => {
    setAngles(currentAngles => {
      const angle = currentAngles.find(a => a.id === angleId);
      if (!angle) return currentAngles;
      setChatThreads(prev => {
        if (prev[angleId]) return prev;
        const followUps = deriveFollowUps(angle);
        const seed: ChatMsg[] = [
          { role: 'system', content: `Investigation thread opened for angle — "${angle.title}". Evidence loaded as context.`, ts: Date.now() },
          { role: 'agent', content: buildAgentSeed(angle, workspaceRef.current?.documents ?? []), ts: Date.now(), quickReplies: followUps },
        ];
        return { ...prev, [angleId]: seed };
      });
      setOpenChatIds(prev => prev.includes(angleId) ? prev : [...prev, angleId]);
      setActiveChatId(angleId);
      setChatMinimized(false);
      if (draft) setChatDraft(draft);
      return currentAngles;
    });
  }, []);

  useEffect(() => {
    api.getWorkspace(workspaceId)
      .then(ws => {
        setWorkspace(ws);
        setAngles(ws.angles);
        const lastTrace = ws.runs?.[0]?.trace;
        if (lastTrace?.length) setTrace(lastTrace);
        generateSuggestion(ws, ws.angles);
      })
      .catch(e => setLoadError(e.message));
  }, [workspaceId]);

  // Poll while a previous run is finishing on the server (status stuck at 'investigating').
  useEffect(() => {
    if (!workspace || running || workspace.status !== 'investigating') return;
    const id = setInterval(() => {
      api.getWorkspace(workspaceId).then(ws => {
        setWorkspace(ws);
        setAngles(ws.angles);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [workspace?.status, running]);

  function requestInvestigate() {
    if (!workspace || running) return;
    const cleanPrompt = mode === 'directed' ? prompt.trim() || null : null;
    if (mode === 'directed' && !cleanPrompt) return;
    const hasExisting = angles.some(a => a.status !== 'dismissed');
    if (hasExisting) { setConfirmOpen(true); return; }
    investigate();
  }

  async function investigate() {
    if (!workspace || running) return;
    const cleanPrompt = mode === 'directed' ? prompt.trim() || null : null;
    setConfirmOpen(false);
    setRunning(true); setTrace([]); setStatusMsg(null); setRunError(null);
    // Preserve pinned angles; drop proposed/dismissed
    setAngles(prev => prev.filter(a => a.status === 'pinned'));
    setSelectedId(id => {
      const pinned = angles.find(a => a.id === id && a.status === 'pinned');
      return pinned ? id : null;
    });

    try {
      const res = await api.investigateStream({ workspaceId, mode, prompt: cleanPrompt });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRunError((body as { detail?: string }).detail ?? `HTTP ${res.status}`);
        setRunning(false);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6)) as SSEEvent;
          if (event.type === 'status') {
            setStatusMsg(event.message);
          } else if (event.type === 'trace') {
            setTrace(t => [...t, { type: 'tool_call', tool: event.tool, input: event.input, resultSummary: event.resultSummary, timestamp: event.timestamp }]);
          } else if (event.type === 'angle_proposed') {
            setAngles(prev => [...prev, event.angle]);
            setSelectedId(id => id ?? event.angle.id);
          } else if (event.type === 'done') {
            setStatusMsg(null);
            const fresh = await api.getWorkspace(workspaceId);
            setWorkspace(fresh); setAngles(fresh.angles);
            if (fresh.runs?.[0]?.trace?.length) setTrace(fresh.runs[0].trace);
          } else if (event.type === 'error') {
            setRunError(event.message);
          }
        }
      }
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }

  async function patchAngle(angleId: string, status: AngleStatus) {
    await api.patchAngle(angleId, status);
    setAngles(prev => prev.map(a => a.id === angleId ? { ...a, status } : a));
    if (status === 'dismissed' && selectedId === angleId) setSelectedId(null);
  }

  async function doSaveRequestCode() {
    const email = saveEmail.trim().toLowerCase();
    if (!email || !email.includes('@') || saving) return;
    setSaving(true); setSaveError(null);
    try {
      await api.requestCode(email);
      setSaveStep('code');
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to send code.');
    } finally {
      setSaving(false);
    }
  }

  async function doSaveVerifyCode() {
    const email = saveEmail.trim().toLowerCase();
    const code  = saveCode.trim();
    if (!code || saving) return;
    setSaving(true); setSaveError(null);
    try {
      const { token, email: verifiedEmail } = await api.verifyCode(email, code);
      setAuthToken(token);
      setOwnerEmail(verifiedEmail);
      setWorkspace(w => w ? { ...w, saved: true, ownerEmail: verifiedEmail } : w);
      setSaveOpen(false);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Invalid code.');
    } finally {
      setSaving(false);
    }
  }

  async function generateSuggestion(ws: WorkspaceDetail, currentAngles: Angle[]) {
    setSuggesting(true);
    setSuggestion('');
    try {
      const docs = ws.documents.map(d => d.filename).join(', ');
      const entities = ws.entities.slice(0, 8).map(e => `${e.name} (${e.type})`).join(', ');
      const found = currentAngles.filter(a => a.status !== 'dismissed').slice(0, 4).map(a => a.title).join('; ');
      const system = `You are a research assistant for an investigative journalist analyzing FOIA documents.
Documents in corpus: ${docs || 'unknown'}${entities ? `\nKey entities identified: ${entities}` : ''}${found ? `\nAngles already found: ${found}` : ''}
Generate ONE specific, focused investigation question a journalist should pursue. Return only the question itself — no preamble, no explanation.`;
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, messages: [{ role: 'user', content: 'Suggest an investigation question.' }] }),
      });
      const { content } = await res.json() as { content: string };
      setSuggestion(content.trim().replace(/^["']|["']$/g, ''));
    } catch {}
    setSuggesting(false);
  }


  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteWorkspace(workspaceId);
      router.push('/workspaces');
    } catch (e: unknown) {
      setDeleting(false);
      setDeleteOpen(false);
      setRunError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function handleUpload() {
    if (uploadFiles.length === 0 || uploading) return;
    setUploading(true); setUploadError(null);
    try {
      const form = new FormData();
      uploadFiles.forEach(f => form.append('files', f));
      await api.uploadDocuments(workspaceId, form);
      const fresh = await api.getWorkspace(workspaceId);
      setWorkspace(fresh); setAddDocsOpen(false); setUploadFiles([]);
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setUploading(false);
    }
  }

  async function handleExtractEntities() {
    if (extracting || running) return;
    setExtracting(true); setExtractError(null);
    try {
      const { entities } = await api.extractEntities(workspaceId);
      setWorkspace(w => w ? { ...w, entities } : w);
    } catch (e: unknown) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function handleBuildTimeline() {
    if (buildingTimeline || running) return;
    setBuildingTimeline(true); setTimelineError(null);
    try {
      const { events } = await api.buildTimeline(workspaceId);
      setWorkspace(w => w ? { ...w, timeline: events } : w);
    } catch (e: unknown) {
      setTimelineError(e instanceof Error ? e.message : 'Timeline build failed');
    } finally {
      setBuildingTimeline(false);
    }
  }

  if (loadError) return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>
      {loadError}
    </div>
  );
  if (!workspace) return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-mute)', fontFamily: 'var(--mono)', fontSize: 11 }}>
      Loading…
    </div>
  );

  const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const byPriority = (a: Angle, b: Angle) =>
    (PRIORITY[a.newsworthiness] ?? 3) - (PRIORITY[b.newsworthiness] ?? 3);

  const pinnedAngles   = angles.filter(a => a.status === 'pinned').sort(byPriority);
  const proposedAngles = angles.filter(a => a.status === 'proposed');
  const visibleAngles  = (tab === 'pinned' ? pinnedAngles : angles.filter(a => a.status !== 'dismissed')).sort(byPriority);
  const selectedAngle  = angles.find(a => a.id === selectedId) ?? null;

  const toolTitle: Record<Tool, string> = { angles: 'Story Angles', entities: 'Entities', timeline: 'Timeline', trace: 'Trace' };
  const toolMeta: Record<Tool, string> = {
    angles:   `${visibleAngles.length} surfaced · ${pinnedAngles.length} pinned`,
    entities: `${workspace.entities.length} unique · cross-doc`,
    timeline: `${workspace.timeline.length} events`,
    trace:    'run log · diagnostic',
  };

  const anglesById = Object.fromEntries(angles.map(a => [a.id, a]));
  const busy = running || extracting || buildingTimeline;

  return (
    <div className="app">
      {/* ── Topbar ── */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name" style={{ cursor: 'pointer' }} onClick={() => router.push('/workspaces')}>FOIALENS</span>
        </div>
        <span className="crumb-sep">/</span>
        <div className="crumb-case">
          <b>{workspace.name}</b>
          <span className="case-id">opened {new Date(workspace.createdAt).toLocaleDateString()}</span>
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-meta">
          {running
            ? <span><span style={{ width: 6, height: 6, background: 'var(--amber)', display: 'inline-block', marginRight: 6, verticalAlign: 'middle', animation: 'pulse 1s infinite' }} />STREAMING</span>
            : <span><span className="dot" />READY · {workspace.chunkCount} chunks</span>
          }
        </div>
        {workspace.saved
          ? <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)', letterSpacing: '0.06em' }}>✓ SAVED</span>
          : <button className="btn btn-amber" onClick={() => { setSaveStep('email'); setSaveEmail(''); setSaveCode(''); setSaveError(null); setSaveOpen(true); }}>Save workspace</button>
        }
        <button className="btn btn-amber" onClick={() => setAddDocsOpen(true)} disabled={busy}>＋ Add docs</button>
        <button className="btn btn-danger" onClick={() => setDeleteOpen(true)} disabled={busy}>Delete</button>
      </header>

      {/* ── Main 3-col ── */}
      <div className="main">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="side-section">
            <h2 className="side-h">Investigate <span className="count">MODE</span></h2>
            <div className="mode-list">
              <button className={`mode ${mode === 'exploratory' ? 'active' : ''}`} onClick={() => setMode('exploratory')}>
                <span className="radio" />
                <span>
                  <div className="label">Explore</div>
                  <div className="desc">Surface all interesting angles across the corpus.</div>
                </span>
              </button>
              <button className={`mode ${mode === 'directed' ? 'active' : ''}`} onClick={() => setMode('directed')}>
                <span className="radio" />
                <span>
                  <div className="label">Directed</div>
                  <div className="desc">Pursue a specific question or hypothesis.</div>
                </span>
              </button>
            </div>

            {mode === 'directed' && (
              <div className="prompt-box">
                {suggestion && !prompt && (
                  <div
                    className="suggestion-chip"
                    onClick={() => setPrompt(suggestion)}
                    title="Click to use this suggestion"
                  >
                    <span className="suggestion-label">suggestion ↗</span>
                    <span className="suggestion-text">{suggestion}</span>
                  </div>
                )}
                {suggesting && !suggestion && (
                  <div className="suggestion-chip generating">
                    <span className="suggestion-label">generating…</span>
                  </div>
                )}
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Describe what you want to investigate…"
                />
                <div className="prompt-foot">
                  <span className="hint">⌘ + ↵ to run</span>
                  <span className="hint">{prompt.length} chars</span>
                </div>
              </div>
            )}

            <button className="investigate-btn" disabled={busy || workspace.status === 'ingesting' || workspace.status === 'investigating'} onClick={requestInvestigate}>
              {running ? <>● STREAMING…</> : <>▶ INVESTIGATE</>}
            </button>

            {!running && workspace.status === 'investigating' && (
              <p style={{ margin: '8px 0 0', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', letterSpacing: '0.04em', lineHeight: 1.5 }}>
                A previous run is still finishing on the server.{' '}
                <span
                  style={{ textDecoration: 'underline', cursor: 'pointer' }}
                  onClick={() => api.resetWorkspaceStatus(workspaceId).then(() =>
                    setWorkspace(w => w ? { ...w, status: 'active' } : w)
                  ).catch(() => {})}
                >
                  Force reset
                </span>
              </p>
            )}
            {statusMsg && (
              <p style={{ margin: '8px 0 0', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', letterSpacing: '0.04em' }}>
                {statusMsg}
              </p>
            )}
            {runError && (
              <p style={{ margin: '8px 0 0', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)', letterSpacing: '0.04em', lineHeight: 1.5 }}>
                {runError}
              </p>
            )}
          </div>

          <div className="side-section">
            <h2 className="side-h">Corpus <span className="count">{workspace.documents.length} DOCS</span></h2>
            <div className="corpus-list">
              {(corpusExpanded ? workspace.documents : workspace.documents.slice(0, 5)).map(d => (
                <div className="corpus-item corpus-item-row" key={d.id} title={d.filename}>
                  <div
                    className="corpus-item-main doc-link"
                    onClick={() => openViewer(d.filename, [], 1)}
                  >
                    <span className="status-dot" />
                    <span className="corpus-name">{d.filename}</span>
                    <span className="corpus-meta">{d.pageCount ? `${d.pageCount}p` : ''}</span>
                  </div>
                  <button
                    className="corpus-delete"
                    title="Delete document"
                    disabled={busy}
                    onClick={e => { e.stopPropagation(); setDeleteDocTarget({ id: d.id, filename: d.filename }); }}
                  >×</button>
                </div>
              ))}
              {workspace.documents.length > 5 && (
                <button className="corpus-item" onClick={() => setCorpusExpanded(e => !e)} style={{ color: 'var(--fg-mute)' }}>
                  <span className="corpus-name" style={{ color: 'var(--fg-mute)' }}>
                    {corpusExpanded ? '▲ Show less' : `▼ +${workspace.documents.length - 5} more`}
                  </span>
                </button>
              )}
              <button className="corpus-item" onClick={() => setAddDocsOpen(true)} style={{ color: 'var(--amber)' }}>
                <span style={{ width: 6, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>＋</span>
                <span className="corpus-name" style={{ color: 'var(--amber)' }}>Add documents</span>
              </button>
            </div>
          </div>

          <div className="side-section" style={{ borderBottom: 0 }}>
            <h2 className="side-h">Tools</h2>
            <div className="tool-list">
              {(['angles', 'entities', 'timeline', 'trace'] as Tool[]).map(t => (
                <button key={t} className={`tool ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)}>
                  <span>{toolTitle[t]}</span>
                  <span className="arrow">›</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Workspace main */}
        <main className="workspace">
          <div className="ws-header">
            <div>
              <span className="ws-title">{toolTitle[tool]}</span>
              <span className="ws-title-meta"> · {toolMeta[tool]}</span>
            </div>
            <div className="ws-spacer" />
            {tool === 'angles' && (
              <div className="tabs">
                <button className={`tab ${tab === 'pinned' ? 'active' : ''}`} onClick={() => setTab('pinned')}>
                  ★ Pinned <span className="pill">{pinnedAngles.length}</span>
                </button>
                <button className={`tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
                  All <span className="pill">{angles.filter(a => a.status !== 'dismissed').length}</span>
                </button>
              </div>
            )}
            {tool === 'entities' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {extractError && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)' }}>{extractError}</span>}
                <button
                  className="btn btn-amber"
                  onClick={handleExtractEntities}
                  disabled={busy || workspace.status === 'investigating'}
                >
                  {extracting ? '● Extracting…' : '▶ Extract entities'}
                </button>
              </div>
            )}
            {tool === 'timeline' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {timelineError && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)' }}>{timelineError}</span>}
                <button
                  className="btn btn-amber"
                  onClick={handleBuildTimeline}
                  disabled={busy || workspace.status === 'investigating'}
                >
                  {buildingTimeline ? '● Building…' : '▶ Build timeline'}
                </button>
              </div>
            )}
          </div>

          {tool === 'angles' && (
            <div className="stream-strip">
              {running ? (
                <>
                  <span className="live"><span className="dot" />LIVE</span>
                  <span className="sep">·</span>
                  <span>SSE stream open · <code>{statusMsg ?? 'initializing'}</code></span>
                  <span className="sep">·</span>
                  <span>{angles.length} angles emitted</span>
                </>
              ) : (
                <>
                  <span>idle · last sync {workspace.updatedAt ? new Date(workspace.updatedAt).toLocaleTimeString() : '—'}</span>
                  <span className="sep">·</span>
                  <span>{angles.filter(a => a.status !== 'dismissed').length} angles · {pinnedAngles.length} pinned</span>
                  <span className="sep">·</span>
                  <span>mode: <code>{mode}</code></span>
                  <span className="sep">·</span>
                  <span>model: <code>{process.env.NEXT_PUBLIC_OPENROUTER_MODEL ?? 'unknown'}</code></span>
                </>
              )}
            </div>
          )}

          {tool === 'angles' && (
            <AngleGrid
              angles={visibleAngles}
              running={running}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPatch={patchAngle}
              onOpenDoc={(docName, pages, focus) => openViewer(docName, pages, focus)}
              onOpenChat={openChat}
              chatThreads={chatThreads}
              documents={workspace.documents}
            />
          )}
          {tool === 'entities' && <EntitiesPane entities={workspace.entities} />}
          {tool === 'timeline' && <TimelinePane events={workspace.timeline} onOpenDoc={(pages) => {
            const doc = findDocForPage(workspace.documents, pages[0]);
            if (doc) openViewer(doc.filename, pages, pages[0]);
          }} />}
          {tool === 'trace' && <TracePane trace={trace} running={running} />}
        </main>

        {/* Inspector */}
        <Inspector
          angle={tool === 'angles' ? selectedAngle : null}
          onPatch={patchAngle}
          onOpenDoc={(page) => {
            if (!selectedAngle) return;
            const doc = findDocForPage(workspace.documents, page);
            if (doc) openViewer(doc.filename, selectedAngle.citations.map(c => c.page), page);
          }}
          onOpenChat={openChat}
          hasChat={selectedAngle ? !!chatThreads[selectedAngle.id] : false}
          chatMsgCount={selectedAngle ? Math.max(0, (chatThreads[selectedAngle.id]?.length ?? 0) - 2) : 0}
        />
      </div>

      {/* Statusbar */}
      <footer className="statusbar">
        <span className="sb-item">CORPUS <b>{workspace.documents.length}</b></span>
        <span className="sb-item">CHUNKS <b>{workspace.chunkCount}</b></span>
        <span className="sb-item">ANGLES <b>{angles.filter(a => a.status !== 'dismissed').length}</b></span>
        <span className="sb-item">PINNED <b>{pinnedAngles.length}</b></span>
        <span className="sb-item">THREADS <b>{Object.keys(chatThreads).length}</b></span>
        <span className="sb-item">
          {running
            ? <span style={{ color: 'var(--amber)' }}>● STREAMING</span>
            : <span style={{ color: 'var(--green)' }}>● READY</span>}
        </span>
        <span className="sb-spacer" />
        <span className="sb-item">{process.env.NEXT_PUBLIC_OPENROUTER_MODEL ?? 'unknown'}</span>
        <span className="sb-item">v0.1.0</span>
      </footer>

      {/* Save workspace modal */}
      {saveOpen && (
        <div className="modal-back" onClick={() => { setSaveOpen(false); setSaveError(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Save workspace</h3>
              <button className="btn btn-sm" onClick={() => { setSaveOpen(false); setSaveError(null); }}>Close</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {saveStep === 'email' ? (
                <>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                    Enter your email to save this workspace permanently. You can recover it on any device by signing in with the same email.
                  </p>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={saveEmail}
                    onChange={e => setSaveEmail(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') doSaveRequestCode(); }}
                    autoFocus
                    style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontFamily: 'var(--sans)', fontSize: 13, outline: 'none' }}
                  />
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                    Enter the code sent to <b>{saveEmail}</b>.
                  </p>
                  <input
                    type="text"
                    placeholder="6-digit code"
                    value={saveCode}
                    onChange={e => setSaveCode(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') doSaveVerifyCode(); }}
                    autoFocus
                    style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontFamily: 'var(--mono)', fontSize: 18, letterSpacing: '0.15em', outline: 'none' }}
                  />
                </>
              )}
              {saveError && <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{saveError}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => { setSaveOpen(false); setSaveError(null); }}>Cancel</button>
              {saveStep === 'email' ? (
                <button className="btn btn-amber" onClick={doSaveRequestCode} disabled={!saveEmail.trim() || saving}>
                  {saving ? 'Sending…' : 'Send code'}
                </button>
              ) : (
                <button className="btn btn-amber" onClick={doSaveVerifyCode} disabled={!saveCode.trim() || saving}>
                  {saving ? 'Verifying…' : 'Verify & save'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add docs modal */}
      {addDocsOpen && (
        <div className="modal-back" onClick={() => { setAddDocsOpen(false); setUploadFiles([]); setUploadError(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Add documents to corpus</h3>
              <button className="btn btn-sm" onClick={() => { setAddDocsOpen(false); setUploadFiles([]); setUploadError(null); }}>Close</button>
            </div>
            <div className="modal-body">
              <UploadZone files={uploadFiles} onChange={setUploadFiles} />
              {uploadError && (
                <p style={{ margin: '8px 0 0', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{uploadError}</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => { setAddDocsOpen(false); setUploadFiles([]); setUploadError(null); }} disabled={uploading}>Cancel</button>
              <button className="btn btn-amber" onClick={handleUpload} disabled={uploadFiles.length === 0 || uploading}>
                {uploading ? 'Uploading…' : 'Begin indexing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Investigate confirmation modal */}
      {confirmOpen && (() => {
        const unpinned = angles.filter(a => a.status === 'proposed');
        const pinned   = angles.filter(a => a.status === 'pinned');
        return (
          <div className="modal-back" onClick={() => setConfirmOpen(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-head">
                <h3>Re-run investigation?</h3>
                <button className="btn btn-sm" onClick={() => setConfirmOpen(false)}>Close</button>
              </div>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
                  Running a new investigation will replace all unpinned angles with fresh results.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pinned.length > 0 && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)', letterSpacing: '0.04em' }}>
                      ✓ {pinned.length} pinned angle{pinned.length !== 1 ? 's' : ''} will be kept
                    </div>
                  )}
                  {unpinned.length > 0 && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)', letterSpacing: '0.04em' }}>
                      ⚠ {unpinned.length} proposed angle{unpinned.length !== 1 ? 's' : ''} will be cleared
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-foot">
                <button className="btn" onClick={() => setConfirmOpen(false)}>Cancel</button>
                <button className="btn btn-amber" onClick={investigate}>Run investigation</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete document modal */}
      {deleteDocTarget && (
        <div className="modal-back" onClick={() => !deletingDoc && setDeleteDocTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete document?</h3>
              <button className="btn btn-sm" onClick={() => setDeleteDocTarget(null)} disabled={deletingDoc}>Close</button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                This will permanently delete <b>{deleteDocTarget.filename}</b> and all its indexed chunks. This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDeleteDocTarget(null)} disabled={deletingDoc}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={deletingDoc}
                onClick={async () => {
                  setDeletingDoc(true);
                  try {
                    await api.deleteDocument(deleteDocTarget.id);
                    setWorkspace(w => w ? { ...w, documents: w.documents.filter(x => x.id !== deleteDocTarget.id) } : w);
                    setDeleteDocTarget(null);
                  } catch (e: unknown) {
                    setRunError(e instanceof Error ? e.message : 'Delete failed');
                    setDeleteDocTarget(null);
                  } finally {
                    setDeletingDoc(false);
                  }
                }}
              >
                {deletingDoc ? 'Deleting…' : 'Delete document'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete workspace modal */}
      {deleteOpen && (
        <div className="modal-back" onClick={() => !deleting && setDeleteOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete workspace?</h3>
              <button className="btn btn-sm" onClick={() => setDeleteOpen(false)} disabled={deleting}>Close</button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                This will permanently delete <b>{workspace.name}</b> and all its documents, chunks, and angles. This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDeleteOpen(false)} disabled={deleting}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete workspace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Doc viewer */}
      <DocViewer
        open={viewer.open}
        doc={viewer.doc}
        pages={viewer.pages}
        focusPage={viewer.focus}
        onClose={closeViewer}
        citations={selectedAngle?.citations ?? []}
        documents={workspace.documents}
      />

      {/* Chat dock */}
      {openChatIds.length > 0 && (
        <ChatDock
          openIds={openChatIds}
          setOpenIds={setOpenChatIds}
          activeId={activeChatId}
          setActiveId={setActiveChatId}
          threads={chatThreads}
          setThreads={setChatThreads}
          anglesById={anglesById}
          minimized={chatMinimized}
          setMinimized={setChatMinimized}
          draft={chatDraft}
          onDraftConsumed={() => setChatDraft('')}
          workspaceName={workspace.name}
          documents={workspace.documents}
          onOpenDoc={openViewer}
        />
      )}
    </div>
  );
}

/* ── Angle grid ──────────────────────────────────────────────────────────── */

function AngleGrid({ angles, running, selectedId, onSelect, onPatch, onOpenDoc, onOpenChat, chatThreads, documents }: {
  angles: Angle[];
  running: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, status: AngleStatus) => void;
  onOpenDoc: (doc: string, pages: number[], focus?: number) => void;
  onOpenChat: (id: string, draft?: string) => void;
  chatThreads: Record<string, ChatMsg[]>;
  documents: Document[];
}) {
  const pinned   = angles.filter(a => a.status === 'pinned');
  const proposed = angles.filter(a => a.status === 'proposed');

  return (
    <div className="grid">
      {pinned.length > 0 && (
        <div className="group-h">
          <span>★ Pinned</span><span className="count">{pinned.length}</span>
          <span className="rule" />
        </div>
      )}
      {pinned.map((a, i) => (
        <AngleCard
          key={a.id} angle={a} isSelected={selectedId === a.id} delay={i * 40}
          onSelect={onSelect} onPatch={onPatch}
          onOpenDoc={(page) => { const d = findDocForPage(documents, page); if (d) onOpenDoc(d.filename, a.citations.map(c => c.page), page); }}
          onOpenChat={onOpenChat}
          hasChat={!!chatThreads[a.id]}
          chatMsgCount={Math.max(0, (chatThreads[a.id]?.length ?? 0) - 2)}
        />
      ))}

      {proposed.length > 0 && (
        <div className="group-h">
          <span>Proposed</span><span className="count">{proposed.length}</span>
          <span className="rule" />
        </div>
      )}
      {proposed.map((a, i) => (
        <AngleCard
          key={a.id} angle={a} isSelected={selectedId === a.id} delay={i * 40}
          onSelect={onSelect} onPatch={onPatch}
          onOpenDoc={(page) => { const d = findDocForPage(documents, page); if (d) onOpenDoc(d.filename, a.citations.map(c => c.page), page); }}
        />
      ))}

      {running && angles.length === 0 && (
        <>
          <div className="skeleton">awaiting angle…</div>
          <div className="skeleton" style={{ animationDelay: '0.3s' }}>awaiting angle…</div>
        </>
      )}
    </div>
  );
}

/* ── Angle card ──────────────────────────────────────────────────────────── */

function AngleCard({ angle, isSelected, delay, onSelect, onPatch, onOpenDoc, onOpenChat, hasChat, chatMsgCount }: {
  angle: Angle;
  isSelected: boolean;
  delay: number;
  onSelect: (id: string) => void;
  onPatch: (id: string, status: AngleStatus) => void;
  onOpenDoc?: (page: number) => void;
  onOpenChat?: (id: string, draft?: string) => void;
  hasChat?: boolean;
  chatMsgCount?: number;
}) {
  const isPinned = angle.status === 'pinned';
  const pages    = (angle.citations ?? []).map(c => c.page).sort((a, b) => a - b);

  return (
    <article
      className={`card ${isPinned ? 'pinned' : ''} ${isSelected ? 'selected' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
      onClick={() => onSelect(angle.id)}
    >
      <div className="card-top">
        <span className="card-id">{angle.id.slice(0, 8).toUpperCase()}</span>
        {isPinned
          ? <span className="pinned-tag"><span className="star">★</span> PINNED</span>
          : <span className="proposed-tag">PROPOSED</span>}
      </div>
      <h3 className="card-headline">{angle.title}</h3>
      <p className="card-summary">{wordTrunc(angle.summary, 28)}</p>
      <div className="card-meta">
        <span className={`badge sev-${angle.newsworthiness.toUpperCase()}`}>● {angle.newsworthiness.toUpperCase()}</span>
        <span className="badge type">{angle.angleType}</span>
      </div>
      {pages.length > 0 && (
        <div className="card-refs" onClick={e => e.stopPropagation()}>
          {pages.slice(0, 6).map((p, i) => (
            <span
              key={i}
              className="doc-link"
              onClick={() => onOpenDoc?.(p)}
              title={`Open page ${p}`}
            >
              <span className="ref-pages">p.{p}</span>
            </span>
          ))}
          {pages.length > 6 && <span className="ref-doc">+{pages.length - 6} more</span>}
        </div>
      )}
      <div className="card-actions" onClick={e => e.stopPropagation()}>
        <button onClick={() => onSelect(angle.id)}>Expand</button>
        {isPinned && onOpenChat && (
          <button className={hasChat ? 'chat-on' : ''} onClick={() => onOpenChat(angle.id)}>
            {hasChat ? `● Chat (${chatMsgCount})` : '○ Open thread'}
          </button>
        )}
        <button className={isPinned ? 'pin-on' : ''} onClick={() => onPatch(angle.id, isPinned ? 'proposed' : 'pinned')}>
          {isPinned ? '★ Pinned' : 'Pin ☆'}
        </button>
        {!isPinned && <button className="dismiss" onClick={() => onPatch(angle.id, 'dismissed')}>Dismiss</button>}
      </div>
    </article>
  );
}

/* ── Inspector ───────────────────────────────────────────────────────────── */

function InspectorBody({ angle, onPatch, onOpenDoc, onOpenChat, hasChat, chatMsgCount }: {
  angle: Angle;
  onPatch: (id: string, status: AngleStatus) => void;
  onOpenDoc: (page: number) => void;
  onOpenChat: (id: string, draft?: string) => void;
  hasChat: boolean;
  chatMsgCount: number;
}) {
  const isPinned  = angle.status === 'pinned';
  const followUps = deriveFollowUps(angle);

  return (
    <>
      <div className="insp-section">
        <h4>Summary</h4>
        <p>{angle.summary}</p>
      </div>

      {angle.evidence.length > 0 && (
        <div className="insp-section">
          <h4>Evidence — {angle.evidence.length}</h4>
          <div className="evidence-list">
            {angle.evidence.map((ev, i) => (
              <div className="ev" key={i}>
                <div className="ev-note">// {ev}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {angle.citations.length > 0 && (
        <div className="insp-section">
          <h4>Source pages</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {angle.citations.map((c, i) => (
              <div
                key={i}
                className="doc-link"
                onClick={() => onOpenDoc(c.page)}
                style={{ fontFamily: 'var(--mono)', fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--fg-dim)' }}>p.{c.page}</span>
                  <span style={{ color: 'var(--amber)' }}>↗</span>
                </div>
                {c.excerpt && (
                  <div style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 8, fontSize: 12, color: 'var(--fg-dim)', fontStyle: 'italic', lineHeight: 1.5 }}>
                    &ldquo;{c.excerpt}&rdquo;
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="insp-section">
        <h4>Follow-up questions</h4>
        <div className="followup-list">
          {followUps.map((q, i) => (
            <div
              key={i}
              className="fu"
              onClick={() => {
                if (isPinned) {
                  onOpenChat(angle.id, q);
                } else {
                  onPatch(angle.id, 'pinned');
                  setTimeout(() => onOpenChat(angle.id, q), 100);
                }
              }}
            >
              <span className="fu-arrow">→</span>
              <span className="fu-text">{q}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="insp-section" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className={`btn ${isPinned ? 'btn-amber' : ''}`} style={{ flex: '1 1 120px' }} onClick={() => onPatch(angle.id, isPinned ? 'proposed' : 'pinned')}>
          {isPinned ? '★ Unpin' : '☆ Pin angle'}
        </button>
        {isPinned && (
          <button className="btn btn-amber" style={{ flex: '1 1 120px' }} onClick={() => onOpenChat(angle.id)}>
            {hasChat ? `● Thread (${chatMsgCount})` : '○ Start thread'}
          </button>
        )}
        {!isPinned && (
          <button className="btn" style={{ flex: '1 1 120px' }} onClick={() => onPatch(angle.id, 'dismissed')}>Dismiss</button>
        )}
      </div>
    </>
  );
}

function Inspector({ angle, onPatch, onOpenDoc, onOpenChat, hasChat, chatMsgCount }: {
  angle: Angle | null;
  onPatch: (id: string, status: AngleStatus) => void;
  onOpenDoc: (page: number) => void;
  onOpenChat: (id: string, draft?: string) => void;
  hasChat: boolean;
  chatMsgCount: number;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!angle) {
    return (
      <aside className="inspector">
        <div className="inspector-empty">
          // FOIALens inspector<br/>
          // ────────────────<br/>
          Select an angle card to inspect<br/>
          evidence, entities, and follow-up<br/>
          questions.<span className="blink" />
        </div>
      </aside>
    );
  }

  const isPinned = angle.status === 'pinned';

  return (
    <aside className="inspector">
      <div className="insp-head">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <div className="insp-id">
            <span>{angle.id.slice(0, 8).toUpperCase()}</span>
            <span style={{ color: 'var(--fg-mute)' }}>·</span>
            <span>{isPinned ? '★ PINNED' : 'PROPOSED'}</span>
          </div>
          <button className="insp-expand-btn" onClick={() => setExpanded(true)} title="Expand to full view">⤢</button>
        </div>
        <h3>{angle.title}</h3>
        <div className="meta-row">
          <span className={`badge sev-${angle.newsworthiness.toUpperCase()}`}>● {angle.newsworthiness.toUpperCase()}</span>
          <span className="badge type">{angle.angleType}</span>
        </div>
      </div>

      <InspectorBody
        angle={angle}
        onPatch={onPatch}
        onOpenDoc={onOpenDoc}
        onOpenChat={onOpenChat}
        hasChat={hasChat}
        chatMsgCount={chatMsgCount}
      />

      {expanded && (
        <div className="modal-back" onClick={() => setExpanded(false)}>
          <div className="insp-modal" onClick={e => e.stopPropagation()}>
            <div className="insp-modal-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.08em', color: 'var(--amber)', marginBottom: 6 }}>
                  {angle.id.slice(0, 8).toUpperCase()} · {isPinned ? '★ PINNED' : 'PROPOSED'}
                </div>
                <h3>{angle.title}</h3>
                <div className="meta-row" style={{ marginTop: 8 }}>
                  <span className={`badge sev-${angle.newsworthiness.toUpperCase()}`}>● {angle.newsworthiness.toUpperCase()}</span>
                  <span className="badge type">{angle.angleType}</span>
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => setExpanded(false)}>ESC ×</button>
            </div>
            <div className="insp-modal-body">
              <InspectorBody
                angle={angle}
                onPatch={onPatch}
                onOpenDoc={(page) => { setExpanded(false); onOpenDoc(page); }}
                onOpenChat={(id, draft) => { setExpanded(false); onOpenChat(id, draft); }}
                hasChat={hasChat}
                chatMsgCount={chatMsgCount}
              />
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/* ── Entities pane ───────────────────────────────────────────────────────── */

function EntitiesPane({ entities }: { entities: WorkspaceDetail['entities'] }) {
  if (entities.length === 0) return (
    <div style={{ padding: '40px 24px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-mute)', letterSpacing: '0.06em' }}>
      No entities extracted yet. Use ▶ Extract entities above or run an investigation.
    </div>
  );
  return (
    <div style={{ padding: '4px 0 60px' }}>
      <table className="pane-table">
        <thead>
          <tr>
            <th style={{ width: '34%' }}>Entity</th>
            <th>Type</th>
            <th style={{ width: '12%', textAlign: 'right' }}>Mentions</th>
          </tr>
        </thead>
        <tbody>
          {[...entities].sort((a, b) => b.mentions - a.mentions).map((e, i) => (
            <tr key={i}>
              <td><span style={{ fontWeight: 500 }}>{e.name}</span></td>
              <td><span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-mute)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{e.type}</span></td>
              <td className="num">{e.mentions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Timeline pane ───────────────────────────────────────────────────────── */

function TimelinePane({ events, onOpenDoc }: { events: WorkspaceDetail['timeline']; onOpenDoc: (pages: number[]) => void }) {
  if (events.length === 0) return (
    <div style={{ padding: '40px 24px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-mute)', letterSpacing: '0.06em' }}>
      No timeline events yet. Use ▶ Build timeline above or run an investigation.
    </div>
  );
  return (
    <div className="timeline-wrap">
      {events.map((t, i) => (
        <div className="tl-item" key={i}>
          <div className="tl-date">{t.date}</div>
          <div className={`tl-marker ${t.confidence}`} />
          <div
            className="tl-body doc-link"
            onClick={() => t.pageRefs.length > 0 && onOpenDoc(t.pageRefs)}
            title={t.pageRefs.length > 0 ? `Open pages ${t.pageRefs.join(', ')}` : ''}
          >
            <div className="tl-label">{t.description}</div>
            <div className="tl-ref">
              ▌ {t.significance.slice(0, 60)}{t.significance.length > 60 ? '…' : ''}
              {t.pageRefs.length > 0 && <> · <span style={{ color: 'var(--amber)' }}>p.{t.pageRefs.join(', ')} ↗</span></>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Trace pane ──────────────────────────────────────────────────────────── */

function TracePane({ trace, running }: { trace: TraceEntry[]; running: boolean }) {
  const lines = trace.map(e => {
    if (e.type === 'tool_call') {
      const q = e.input && 'query' in e.input ? ` "${String(e.input.query).slice(0, 40)}"` : '';
      return `[ ${new Date(e.timestamp).toISOString().slice(11, 19)} ] ${e.tool}${q}\n              → ${e.resultSummary ?? ''}`;
    }
    return `[ final ] ${e.content?.slice(0, 80) ?? ''}`;
  }).join('\n\n');

  return (
    <div className="trace-pane">
      <div style={{ color: 'var(--fg-mute)', letterSpacing: '0.1em', textTransform: 'uppercase', fontSize: 10, marginBottom: 14 }}>
        /// run_trace · model {process.env.NEXT_PUBLIC_OPENROUTER_MODEL ?? 'unknown'}
      </div>
      <pre>{lines || (running ? '[ streaming… ]' : '// No trace yet. Run an investigation.')}</pre>
    </div>
  );
}

/* ── Doc viewer ──────────────────────────────────────────────────────────── */

type DocType = 'bid' | 'minutes' | 'invoice' | 'email' | 'csv' | 'letter' | 'table' | 'report';

function docTypeOf(name: string): DocType {
  const n = (name || '').toLowerCase();
  if (n.includes('bid_packet')) return 'bid';
  if (n.includes('council_minutes')) return 'minutes';
  if (n.includes('vendor_invoices') || n.includes('invoice')) return 'invoice';
  if (n.includes('procurement_emails') || n.endsWith('.mbox')) return 'email';
  if (n.includes('campaign_finance') || n.endsWith('.csv')) return 'csv';
  if (n.includes('audit_letter')) return 'letter';
  if (n.includes('appendix') || n.endsWith('.xlsx')) return 'table';
  return 'report';
}

function docExt(name: string) {
  const m = name?.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : 'PDF';
}
function docDisplayName(name: string) {
  return (name || '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
}
function inferTotalPages(name: string | null): number {
  if (!name) return 100;
  const hints: Record<string, number> = { city_contracts_report: 412, appendix_a: 84, council_minutes: 156, procurement_emails: 198, audit_letter: 12, bid_packet: 67, vendor_invoices: 891 };
  for (const [k, v] of Object.entries(hints)) { if (name.includes(k)) return v; }
  return 100;
}

const SENTENCES = [
  "Pursuant to section 14.3, the contracting officer shall document the rationale for any deviation from competitive procurement procedures.",
  "The contractor warrants that all deliverables shall conform to the specifications set forth in Appendix B of this agreement.",
  "Payment terms shall be net thirty (30) days from receipt of properly submitted invoice, subject to acceptance of deliverables.",
  "No change to the scope of work shall be valid unless executed by written change order signed by both parties.",
  "The vendor shall maintain commercial general liability insurance in the amount of not less than two million dollars ($2,000,000).",
  "All work product shall become the sole and exclusive property of the City upon payment in full.",
  "The parties acknowledge that time is of the essence with respect to the performance of all obligations hereunder.",
  "Either party may terminate this agreement for convenience upon thirty (30) days prior written notice.",
  "Confidential information disclosed under this agreement shall be subject to the confidentiality provisions of section 12.",
  "Disputes arising under this agreement shall be resolved through binding arbitration in accordance with state procurement code.",
];

function BlockText({ lines = 4, redacted = false }: { lines?: number; redacted?: boolean }) {
  const widths = useMemo(() => {
    const arr = [];
    for (let i = 0; i < lines; i++) arr.push(85 + ((i * 17) % 14));
    arr[arr.length - 1] = 38 + ((lines * 9) % 30);
    return arr;
  }, [lines]);
  return (
    <div className="page-prose">
      {widths.map((w, i) => (
        <div key={i} className={`prose-line ${redacted && i % 3 === 1 ? 'redacted' : ''}`} style={{ width: `${w}%` }}>
          {!(redacted && i % 3 === 1) && SENTENCES[i % SENTENCES.length]}
        </div>
      ))}
    </div>
  );
}

function HighlightBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="hl-wrap">
      <span className="hl-tag">▌ CITED</span>
      <div className="hl-content">{children}</div>
    </div>
  );
}

function MockPageMini({ cited }: { cited: boolean }) {
  return (
    <div className="thumb-paper">
      <div className="thumb-band" />
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="thumb-line" style={{ width: `${65 + (i * 13) % 30}%` }} />
      ))}
      {cited && <div className="thumb-highlight" />}
    </div>
  );
}

const DOC_LABELS: Record<DocType, string> = {
  bid: 'BID PACKET — 2019 IT SERVICES PROCUREMENT',
  minutes: 'CITY COUNCIL MEETING MINUTES',
  invoice: 'VENDOR INVOICE CONSOLIDATION',
  email: 'EMAIL CORRESPONDENCE — PROCUREMENT OFFICE',
  csv: 'CAMPAIGN FINANCE DISCLOSURE',
  letter: 'INTERNAL AUDIT — DRAFT',
  table: 'APPENDIX A — APPROVED VENDOR LIST',
  report: 'CONTRACT REVIEW REPORT — 2023',
};

function PageContent({ type, page, highlight }: { type: DocType; page: number; highlight: string | null }) {
  if (type === 'bid') return (
    <>
      <h2 className="page-h">SECTION {((page % 7) + 1).toString().padStart(2, '0')}.{page} — STATEMENT OF WORK</h2>
      <div className="page-field-row"><span className="page-field-label">CONTRACTOR:</span><span className="page-field-value">ACME CORPORATION, LLC</span></div>
      <div className="page-field-row"><span className="page-field-label">CONTRACT NO.:</span><span className="page-field-value">CC-2019-{(2400 + page)}</span></div>
      <div className="page-field-row"><span className="page-field-label">VALUE:</span><span className="page-field-value">$12,400,000.00</span></div>
      <div className="page-field-row"><span className="page-field-label">PROCUREMENT METHOD:</span><span className="page-field-value redacted-inline">{highlight ? 'sole-source emergency' : 'see classification memo'}</span></div>
      {highlight ? <HighlightBlock>{highlight}</HighlightBlock> : <BlockText lines={4} />}
      <h3 className="page-h-sub">{page}.1 Scope</h3><BlockText lines={6} />
      <h3 className="page-h-sub">{page}.2 Deliverables</h3><BlockText lines={3} redacted />
      <div className="page-stamp"><div className="stamp">CONFIDENTIAL</div></div>
    </>
  );
  if (type === 'minutes') return (
    <>
      <h2 className="page-h">MEETING OF THE FINANCE COMMITTEE</h2>
      <div className="page-field-row"><span className="page-field-label">DATE:</span><span className="page-field-value">2021-07-15</span></div>
      <div className="page-field-row"><span className="page-field-label">CHAIR:</span><span className="page-field-value">Council Member Yates</span></div>
      <h3 className="page-h-sub">MOTION 14-B — VENDOR SELECTION REVIEW</h3>
      <BlockText lines={3} />
      {highlight ? <HighlightBlock>{highlight}</HighlightBlock> : <BlockText lines={4} />}
      <h3 className="page-h-sub">VOTE TALLY</h3>
      <div className="page-vote"><div><b>AYE</b> · 5 (Yates, Brennan, Park[R], Cho, Nguyen)</div><div><b>NAY</b> · 1 (Aldermann)</div><div><b>ABSTAIN</b> · 1 (Velasco)</div></div>
    </>
  );
  if (type === 'invoice') {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      inv: `INV-${2020 + (page % 3)}-${(page * 11 + i).toString().padStart(4, '0')}`,
      vendor: ['Meridian Advisory', 'BlueLine Consulting', 'Tessera Group', 'Acme Corp'][(i + page) % 4],
      amt: (40000 + ((i * 23 + page * 7) % 90) * 1000).toLocaleString(),
      deliv: i % 3 === 0 ? '—' : 'attached',
    }));
    return (
      <>
        <h2 className="page-h">CONSOLIDATED INVOICE REGISTER</h2>
        <div className="page-field-row"><span className="page-field-label">PERIOD:</span><span className="page-field-value">FY {2020 + (page % 4)} Q{(page % 4) + 1}</span></div>
        {highlight && <HighlightBlock>{highlight}</HighlightBlock>}
        <table className="invoice-table">
          <thead><tr><th>INVOICE</th><th>VENDOR</th><th style={{ textAlign: 'right' }}>AMOUNT (USD)</th><th>DELIVERABLE</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className={r.deliv === '—' ? 'flag' : ''}><td>{r.inv}</td><td>{r.vendor}</td><td style={{ textAlign: 'right' }}>${r.amt}</td><td>{r.deliv}</td></tr>)}</tbody>
        </table>
      </>
    );
  }
  if (type === 'email') return (
    <>
      <h2 className="page-h">MESSAGE #{page * 13}</h2>
      <div className="email-head">
        <div><b>FROM:</b> j.scott@acmecorp.com</div><div><b>TO:</b> procurement@city.gov</div>
        <div><b>CC:</b> l.park@city.gov</div><div><b>DATE:</b> 2019-08-12 14:33</div>
        <div><b>SUBJECT:</b> Re: classification — IT services scope</div>
      </div>
      <BlockText lines={4} />
      {highlight ? <HighlightBlock>{highlight}</HighlightBlock> : <BlockText lines={6} />}
      <div className="email-sig">--<br/>J. Scott · Director, Public Sector · Acme Corporation</div>
    </>
  );
  if (type === 'letter') return (
    <>
      <div className="letterhead">OFFICE OF THE INSPECTOR GENERAL · INTERNAL AUDIT DIVISION</div>
      <div className="page-field-row"><span className="page-field-label">DATE:</span><span className="page-field-value">2023-01-30 — DRAFT, NOT SENT</span></div>
      <h2 className="page-h">RE: REVIEW OF PROCUREMENT PRACTICES, FY 2019–2022</h2>
      <BlockText lines={4} />
      {highlight ? <HighlightBlock>{highlight}</HighlightBlock> : <BlockText lines={5} />}
      <BlockText lines={3} redacted />
      <div className="page-sig"><div className="sig-line" /><div className="sig-name">[NAME REDACTED]</div><div className="sig-title">Acting Inspector General</div></div>
    </>
  );
  if (type === 'table') {
    const vendors = [['V-0142','Acme Corporation','IT SERVICES','ACTIVE','$12.4M'],['V-0211','Meridian Advisory','CONSULTING','ACTIVE','$1.8M'],['V-0314','BlueLine Consulting','CONSULTING','ACTIVE','$1.2M'],['V-0518','Helios Systems','IT SERVICES','ACTIVE','$3.4M'],['V-0623','Northgate Logistics','LOGISTICS','INACTIVE','$0.4M']];
    return (
      <>
        <h2 className="page-h">APPENDIX A — APPROVED VENDOR LIST (PAGE {page})</h2>
        <table className="vendor-table">
          <thead><tr><th>ID</th><th>VENDOR</th><th>CATEGORY</th><th>STATUS</th><th style={{ textAlign: 'right' }}>TOTAL AWARDED</th></tr></thead>
          <tbody>{vendors.map((r, i) => <tr key={i}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td className={`vs-${r[3]}`}>{r[3]}</td><td style={{ textAlign: 'right' }}>{r[4]}</td></tr>)}</tbody>
        </table>
      </>
    );
  }
  // report / csv default
  return (
    <>
      <h2 className="page-h">§ {Math.ceil(page / 10)}.{(page % 10) + 1} — Findings and Observations</h2>
      <BlockText lines={5} />
      {highlight ? <HighlightBlock>{highlight}</HighlightBlock> : <BlockText lines={6} />}
      <h3 className="page-h-sub">Cross-references</h3>
      <BlockText lines={3} />
    </>
  );
}

import type { Citation } from '../../../lib/types';

function DocViewer({ open, doc, pages, focusPage, onClose, citations, documents }: {
  open: boolean;
  doc: string | null;
  pages: number[];
  focusPage: number;
  onClose: () => void;
  citations: Citation[];
  documents: Array<{ id: string; filename: string; pageCount: number | null }>;
}) {
  const [focusedPage, setFocusedPage] = useState(focusPage || 1);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState(false);

  const docRecord = documents.find(d => d.filename === doc);

  useEffect(() => {
    if (!open) return;
    setFocusedPage(focusPage || pages?.[0] || 1);
    setPdfUrl(null);
    setUrlError(false);
    if (!docRecord?.id) return;
    api.getDocumentUrl(docRecord.id)
      .then(({ url }) => setPdfUrl(url))
      .catch(() => setUrlError(true));
  }, [open, doc, focusPage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const citedSet = useMemo(() => new Set(pages), [pages]);

  if (!open) return null;

  return (
    <div className="viewer-back" onClick={onClose}>
      <div className="viewer" onClick={e => e.stopPropagation()}>
        <div className="viewer-toolbar">
          <div className="viewer-doc">
            <span className="viewer-doc-ext">{docExt(doc ?? '')}</span>
            <div>
              <div className="viewer-doc-name">{docDisplayName(doc ?? '')}</div>
              <div className="viewer-doc-meta">
                {docRecord?.pageCount ? `${docRecord.pageCount} pages` : ''}
                {citedSet.size > 0 ? ` · ${citedSet.size} cited` : ''}
              </div>
            </div>
          </div>
          <div className="viewer-actions">
            {citedSet.size > 0 && (
              <span className="viewer-cited">
                CITED:&nbsp;
                {Array.from(citedSet).sort((a, b) => a - b).map(p => (
                  <button
                    key={p}
                    className={`viewer-cite-jump ${focusedPage === p ? 'active' : ''}`}
                    onClick={() => setFocusedPage(p)}
                  >p.{p}</button>
                ))}
              </span>
            )}
            <button className="btn btn-sm" onClick={onClose}>ESC ×</button>
          </div>
        </div>

        <div className="viewer-body" style={{ gridTemplateRows: '1fr' }}>
          <div className="viewer-canvas" style={{ padding: 0, gridColumn: '1 / -1', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {urlError ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                PDF not available — file storage not configured.
              </div>
            ) : pdfUrl ? (
              <iframe
                key={focusedPage}
                src={`${pdfUrl}#page=${focusedPage}`}
                style={{ width: '100%', flex: 1, border: 'none', display: 'block' }}
                title={doc ?? 'Document'}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                Loading…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Chat dock ───────────────────────────────────────────────────────────── */

function ChatDock({ openIds, setOpenIds, activeId, setActiveId, threads, setThreads, anglesById, minimized, setMinimized, draft, onDraftConsumed, workspaceName, documents, onOpenDoc }: {
  openIds: string[];
  setOpenIds: (ids: string[]) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  threads: Record<string, ChatMsg[]>;
  setThreads: (fn: (prev: Record<string, ChatMsg[]>) => Record<string, ChatMsg[]>) => void;
  anglesById: Record<string, Angle>;
  minimized: boolean;
  setMinimized: (m: boolean | ((prev: boolean) => boolean)) => void;
  draft: string;
  onDraftConsumed: () => void;
  workspaceName: string;
  documents: Document[];
  onOpenDoc: (doc: string, pages: number[], focus: number) => void;
}) {
  const closeTab = (id: string) => {
    const next = openIds.filter(x => x !== id);
    setOpenIds(next);
    if (activeId === id) setActiveId(next[0] ?? null);
  };

  // Draggable mini-pill state
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  const onMiniMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    movedRef.current = false;

    const dockEl = e.currentTarget.closest<HTMLElement>('.chat-dock')!;
    const rect   = dockEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX  = rect.left;
    const origY  = rect.top;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!movedRef.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      movedRef.current = true;
      document.body.style.cursor = 'grabbing';
      setMiniPos({
        x: Math.max(0, Math.min(window.innerWidth  - dockEl.offsetWidth,  origX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - dockEl.offsetHeight, origY + dy)),
      });
    }

    function onUp() {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, []);

  const appendMsg = (angleId: string, msg: ChatMsg) => {
    setThreads(prev => {
      const msgs = [...(prev[angleId] ?? []), { ...msg, ts: msg.ts || Date.now() }];
      return { ...prev, [angleId]: msgs };
    });
  };

  const updateStreaming = (angleId: string, content: string) => {
    setThreads(prev => {
      const msgs = [...(prev[angleId] ?? [])];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'agent' && last.streaming) msgs[msgs.length - 1] = { ...last, content };
      return { ...prev, [angleId]: msgs };
    });
  };

  const finishStreaming = (angleId: string) => {
    setThreads(prev => {
      const msgs = [...(prev[angleId] ?? [])];
      const last = msgs[msgs.length - 1];
      if (last?.streaming) msgs[msgs.length - 1] = { ...last, streaming: false };
      return { ...prev, [angleId]: msgs };
    });
  };

  const clearThread = (angleId: string) => {
    const angle = anglesById[angleId];
    if (!angle) return;
    const followUps = deriveFollowUps(angle);
    const seed: ChatMsg[] = [
      { role: 'system', content: `Investigation thread opened for angle — "${angle.title}". Evidence loaded as context.`, ts: Date.now() },
      { role: 'agent', content: buildAgentSeed(angle, documents), ts: Date.now(), quickReplies: followUps },
    ];
    setThreads(prev => ({ ...prev, [angleId]: seed }));
  };

  const activeAngle = activeId ? anglesById[activeId] : null;

  if (minimized) {
    const miniStyle: React.CSSProperties = miniPos
      ? { left: miniPos.x, top: miniPos.y, right: 'auto', bottom: 'auto' }
      : {};
    return (
      <div className="chat-dock mini" style={miniStyle}>
        <button
          className="chat-dock-icon"
          style={{ cursor: 'grab' }}
          onMouseDown={onMiniMouseDown}
          onClick={() => {
            if (movedRef.current) { movedRef.current = false; return; }
            setMiniPos(null);
            setMinimized(false);
          }}
        >
          <span>★ THREADS</span>
          <span className="chat-dock-badge">{openIds.length}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="chat-dock">
      <div className="chat-tabs">
        <span className="chat-tabs-label">★ THREADS</span>
        {openIds.map(id => {
          const a = anglesById[id];
          if (!a) return null;
          const msgs = threads[id] ?? [];
          const last = msgs[msgs.length - 1];
          const isTyping = last?.role === 'agent' && last.streaming;
          return (
            <button key={id} className={`chat-tab ${activeId === id ? 'active' : ''}`} onClick={() => setActiveId(id)} title={a.title}>
              <span className="chat-tab-id">{a.id.slice(0, 5).toUpperCase()}</span>
              <span className="chat-tab-head">{a.title.length > 26 ? a.title.slice(0, 25) + '…' : a.title}</span>
              {isTyping && <span className="chat-tab-dot" />}
              <span className="chat-tab-x" onClick={e => { e.stopPropagation(); closeTab(id); }}>×</span>
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <button className="chat-mini" onClick={() => setMinimized(true)}>▼</button>
      </div>

      {activeAngle && (
        <ChatWindow
          key={activeId!}
          angle={activeAngle}
          messages={threads[activeId!] ?? []}
          onAppend={msg => appendMsg(activeId!, msg)}
          onUpdateStreaming={c => updateStreaming(activeId!, c)}
          onFinishStreaming={() => finishStreaming(activeId!)}
          onClear={() => clearThread(activeId!)}
          externalDraft={draft}
          onDraftConsumed={onDraftConsumed}
          workspaceName={workspaceName}
          documents={documents}
          onOpenDoc={onOpenDoc}
        />
      )}
    </div>
  );
}

function ChatWindow({ angle, messages, onAppend, onUpdateStreaming, onFinishStreaming, onClear, externalDraft, onDraftConsumed, workspaceName, documents, onOpenDoc }: {
  angle: Angle;
  messages: ChatMsg[];
  onAppend: (msg: ChatMsg) => void;
  onUpdateStreaming: (content: string) => void;
  onFinishStreaming: () => void;
  onClear: () => void;
  externalDraft: string;
  onDraftConsumed: () => void;
  workspaceName: string;
  documents: Document[];
  onOpenDoc: (doc: string, pages: number[], focus: number) => void;
}) {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    if (messages.length <= 2) {
      scrollRef.current.scrollTop = 0;
    } else {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, messages[messages.length - 1]?.content]);

  useEffect(() => {
    if (!externalDraft) return;
    setInput(externalDraft);
    onDraftConsumed();
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(externalDraft.length, externalDraft.length); }
    });
  }, [externalDraft]);

  const fillDraft = (text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(text.length, text.length); }
    });
  };

  const send = async (text: string) => {
    if (!text.trim() || pending) return;
    onAppend({ role: 'user', content: text.trim(), ts: Date.now() });
    onAppend({ role: 'agent', content: '', streaming: true, ts: Date.now() });
    setInput('');
    setPending(true);

    const convo = messages
      .filter(m => m.role === 'user' || m.role === 'agent')
      .filter(m => !m.streaming)
      .map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content }));
    convo.push({ role: 'user', content: text.trim() });

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: buildChatSystem(angle, workspaceName, documents), messages: convo }),
      });
      const { content } = await res.json() as { content: string };
      // Simulate streaming output
      const words = content.split(/(\s+)/);
      let acc = '';
      for (const w of words) {
        acc += w;
        onUpdateStreaming(acc);
        await new Promise(r => setTimeout(r, 12));
      }
    } catch {
      onUpdateStreaming('[ Network error — agent unreachable ]');
    }
    onFinishStreaming();
    setPending(false);
  };

  return (
    <div className="chat-window">
      <div className="chat-head">
        <div>
          <div className="chat-head-id">{angle.id.slice(0, 8).toUpperCase()} · ★ PINNED · {angle.newsworthiness.toUpperCase()}</div>
          <div className="chat-head-title">{angle.title}</div>
        </div>
        <div className="chat-head-actions">
          <button className="btn btn-sm" onClick={onClear} title="Reset thread">⟲</button>
        </div>
      </div>

      <div className="chat-body" ref={scrollRef}>
        {messages.map((m, i) => <ChatMessage key={i} msg={m} onQuickReply={fillDraft} documents={documents} onOpenDoc={onOpenDoc} />)}
      </div>

      <div className="chat-composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
          }}
          placeholder={pending ? 'Agent is responding…' : 'Ask the agent about this angle…'}
          disabled={pending}
          rows={2}
        />
        <div className="chat-composer-foot">
          <span className="chat-hint">↵ to send · {angle.evidence.length} evidence items · {angle.citations.length} pages</span>
          <button className="btn btn-amber btn-sm" onClick={() => send(input)} disabled={pending || !input.trim()}>
            {pending ? '…' : 'SEND ↵'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Converts [filename, p.N] (and pp.N-M) citation syntax into #cite/ fragment
// links. react-markdown v10 strips unknown URL schemes (cite://) but passes
// fragment-only URLs through defaultUrlTransform unchanged.
function injectCiteLinks(text: string): string {
  return text.replace(/\[([^\]]+),\s*pp?\.(\d+)(?:-\d+)?\]/g, (_, filename, page) => {
    const name = filename.trim();
    const display = name.length > 10 ? name.slice(0, 10) + '…' : name;
    return `[[${display}, p.${page}]](#cite/${encodeURIComponent(name)}/${page})`;
  });
}

function ChatMessage({ msg, onQuickReply, documents, onOpenDoc }: {
  msg: ChatMsg;
  onQuickReply: (q: string) => void;
  documents: Document[];
  onOpenDoc: (doc: string, pages: number[], focus: number) => void;
}) {
  if (msg.role === 'system') {
    return <div className="chat-system">// {msg.content}</div>;
  }
  if (msg.role === 'user') {
    return (
      <div className="chat-row user">
        <div className="chat-bubble user">{msg.content}</div>
        <div className="chat-meta">YOU · {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    );
  }

  const citeComponents = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href?.startsWith('#cite/')) {
        const rest = href.slice('#cite/'.length);
        const slashIdx = rest.lastIndexOf('/');
        const filename = decodeURIComponent(rest.slice(0, slashIdx));
        const page = parseInt(rest.slice(slashIdx + 1), 10);
        const doc = documents.find(d => d.filename === filename);
        return (
          <button
            className="chat-cite"
            onClick={() => doc && onOpenDoc(doc.filename, [page], page)}
            title={doc ? `Open ${filename} p.${page}` : filename}
          >
            {children}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
  };

  return (
    <div className="chat-row agent">
      <div className="chat-meta">▌ AGENT{msg.streaming ? ' · typing…' : ''}</div>
      <div className="chat-bubble agent">
        {msg.content
          ? <>
              <ReactMarkdown components={citeComponents}>{injectCiteLinks(msg.content)}</ReactMarkdown>
              {msg.streaming && <span className="chat-cursor">▍</span>}
            </>
          : <span className="chat-cursor">▍</span>}
      </div>
      {msg.quickReplies && msg.quickReplies.length > 0 && (
        <div className="chat-quickreplies">
          {msg.quickReplies.map((q, i) => (
            <button key={i} className="chat-qr" onClick={() => onQuickReply(q)}>→ {q}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function wordTrunc(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '…';
}

// React needs to be in scope for JSX in sub-components
import React from 'react';
