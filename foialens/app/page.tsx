'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api';
import { getOwnerEmail, setOwnerEmail } from '../lib/session';
import type { WorkspaceListItem } from '../lib/types';
import UploadZone from '../components/UploadZone';

export default function Home() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [showModal, setShowModal]   = useState(false);
  const [wsName, setWsName]         = useState('');
  const [files, setFiles]           = useState<File[]>([]);
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [signedInAs, setSignedInAs] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setSignedInAs(getOwnerEmail());
    api.listWorkspaces()
      .then(setWorkspaces)
      .catch(e => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function handleSignIn() {
    const e = emailDraft.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    setOwnerEmail(e);
    setSignedInAs(e);
    setEmailDraft('');
    setLoading(true);
    api.listWorkspaces()
      .then(setWorkspaces)
      .catch(e => setLoadError(e.message))
      .finally(() => setLoading(false));
  }

  function handleSignOut() {
    setOwnerEmail('');
    setSignedInAs('');
    setLoading(true);
    api.listWorkspaces()
      .then(setWorkspaces)
      .catch(e => setLoadError(e.message))
      .finally(() => setLoading(false));
  }

  function closeModal() {
    setShowModal(false); setWsName(''); setFiles([]); setCreateError(null);
  }

  async function handleCreate() {
    if (!wsName.trim() || files.length === 0 || creating) return;
    setCreating(true); setCreateError(null);
    try {
      const form = new FormData();
      form.append('name', wsName.trim());
      files.forEach(f => form.append('files', f));
      const result = await api.createWorkspace(form);
      router.push(`/workspace/${result.workspaceId}`);
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Unknown error');
      setCreating(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)' }}>
      {/* topbar */}
      <header className="topbar" style={{ height: 44 }}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">FOIALENS</span>
        </div>
        <div className="topbar-spacer" />
        {signedInAs ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)', letterSpacing: '0.06em' }}>
              ✓ {signedInAs}
            </span>
            <button className="btn btn-sm" onClick={handleSignOut}>Sign out</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="email"
              placeholder="Recover workspaces by email…"
              value={emailDraft}
              onChange={e => setEmailDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSignIn()}
              style={{ padding: '4px 8px', background: 'var(--bg-2)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', width: 220 }}
            />
            <button className="btn btn-sm" onClick={handleSignIn} disabled={!emailDraft.trim()}>Sign in</button>
          </div>
        )}
        <button className="btn btn-amber" onClick={() => setShowModal(true)}>＋ New workspace</button>
      </header>

      {/* create modal */}
      {showModal && (
        <div className="modal-back" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>New workspace</h3>
              <button className="btn btn-sm" onClick={closeModal}>Close</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                placeholder="Workspace name — e.g. City Hall Contracts 2019–2023"
                value={wsName}
                onChange={e => setWsName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                autoFocus
                style={{
                  width: '100%', padding: '8px 10px',
                  background: 'var(--bg-2)', border: '1px solid var(--border-strong)',
                  color: 'var(--fg)', fontFamily: 'var(--sans)', fontSize: 13,
                  outline: 'none',
                }}
              />
              <UploadZone files={files} onChange={setFiles} />
              {createError && (
                <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>
                  {createError}
                </p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={closeModal} disabled={creating}>Cancel</button>
              <button
                className="btn btn-amber"
                onClick={handleCreate}
                disabled={!wsName.trim() || files.length === 0 || creating}
              >
                {creating ? 'Ingesting…' : `Ingest ${files.length} file${files.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* workspace list */}
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 13, fontFamily: 'var(--mono)', fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>
            Workspaces
          </h1>
          {!loading && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-mute)', letterSpacing: '0.08em' }}>
              {workspaces.length} total
            </span>
          )}
        </div>

        {loading ? (
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-mute)', letterSpacing: '0.06em' }}>
            Loading…
          </p>
        ) : loadError ? (
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{loadError}</p>
        ) : workspaces.length === 0 ? (
          <div style={{ padding: '80px 0', textAlign: 'center' }}>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-mute)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
              No workspaces yet
            </p>
            <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: 0 }}>
              Create one by uploading a set of FOIA documents.
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {workspaces.map(ws => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                onClick={() => router.push(`/workspace/${ws.id}`)}
                onDelete={() => setDeleteTarget(ws)}
              />
            ))}
          </div>
        )}
      </div>

      {/* delete workspace modal */}
      {deleteTarget && (
        <div className="modal-back" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete workspace?</h3>
              <button className="btn btn-sm" onClick={() => setDeleteTarget(null)} disabled={deleting}>Close</button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                This will permanently delete <b>{deleteTarget.name}</b> and all its documents, chunks, and angles. This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await api.deleteWorkspace(deleteTarget.id);
                    setWorkspaces(prev => prev.filter(w => w.id !== deleteTarget.id));
                    setDeleteTarget(null);
                  } catch (e: unknown) {
                    setLoadError(e instanceof Error ? e.message : 'Delete failed');
                    setDeleteTarget(null);
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? 'Deleting…' : 'Delete workspace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* statusbar */}
      <footer className="statusbar" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 24 }}>
        <span className="sb-item">WORKSPACES <b>{workspaces.length}</b></span>
        <span className="sb-spacer" />
        <span className="sb-item">FOIALENS</span>
        <span className="sb-item">v0.1.0</span>
      </footer>
    </div>
  );
}

function WorkspaceCard({ ws, onClick, onDelete }: { ws: WorkspaceListItem; onClick: () => void; onDelete: () => void }) {
  const statusColors: Record<string, string> = {
    ingesting:    'var(--amber)',
    ready:        'var(--fg-mute)',
    investigating:'var(--blue)',
    active:       'var(--green)',
  };
  return (
    <div
      className="ws-card"
      onClick={onClick}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.005em', flex: 1 }}>
          {ws.name}
        </span>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: statusColors[ws.status] ?? 'var(--fg-mute)' }}>
              ● {ws.status}
            </span>
            {!ws.saved && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--amber)' }}>
                expires 7d
              </span>
            )}
          </div>
          <button
            className="ws-card-delete"
            title="Delete workspace"
            onClick={e => { e.stopPropagation(); onDelete(); }}
          >×</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-mute)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span>{ws.documentCount} doc{ws.documentCount !== 1 ? 's' : ''}</span>
        <span>{ws.angleCount} angle{ws.angleCount !== 1 ? 's' : ''}</span>
        {ws.pinnedCount > 0 && <span style={{ color: 'var(--amber)' }}>★ {ws.pinnedCount} pinned</span>}
      </div>
      {ws.lastRunAt && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-mute)', letterSpacing: '0.04em' }}>
          Last run {new Date(ws.lastRunAt).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}
