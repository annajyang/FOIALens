import type { WorkspaceListItem, WorkspaceDetail, AngleStatus } from './types';

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}/api${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function multipartFetch<T>(path: string, form: FormData, method = 'POST'): Promise<T> {
  return fetch(`${BACKEND}/api${path}`, { method, body: form }).then(async res => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { detail?: string }).detail ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  });
}

export const api = {
  listWorkspaces: () =>
    apiFetch<{ workspaces: WorkspaceListItem[] }>('/workspaces').then(r => r.workspaces),

  getWorkspace: (id: string) =>
    apiFetch<{ workspace: WorkspaceDetail }>(`/workspaces/${id}`).then(r => r.workspace),

  createWorkspace: (form: FormData) =>
    multipartFetch<{ workspaceId: string; documentCount: number; chunkCount: number }>('/workspaces', form),

  uploadDocuments: (workspaceId: string, form: FormData) =>
    multipartFetch<{ addedDocuments: number; addedChunks: number; totalChunks: number }>(
      `/workspaces/${workspaceId}/upload`,
      form,
    ),

  renameWorkspace: (workspaceId: string, name: string) =>
    apiFetch<{ id: string; name: string }>(`/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  patchAngle: (angleId: string, status: AngleStatus) =>
    apiFetch<{ id: string; status: AngleStatus; updatedAt: string }>(`/angles/${angleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),

  investigateStream: (body: { workspaceId: string; mode: string; prompt?: string | null }) =>
    fetch(`${BACKEND}/api/investigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getDocumentUrl: (docId: string) =>
    apiFetch<{ url: string }>(`/documents/${docId}/url`),
};
