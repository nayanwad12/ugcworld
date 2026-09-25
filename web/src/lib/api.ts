import type { AppConfig, Asset, Brief, Clip, EditSettings, Project, Script, Stage } from '../../../shared/types.ts';

export type ProjectSummary = {
  id: string;
  name: string;
  stage: Stage;
  updatedAt: string;
  platform: string;
  durationSec: number;
  thumb?: string;
  finalUrl?: string;
};

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  config: () => req<AppConfig>('GET', '/config'),
  projects: () => req<ProjectSummary[]>('GET', '/projects'),
  createProject: (name: string) => req<Project>('POST', '/projects', { name }),
  project: (id: string) => req<Project>('GET', `/projects/${id}`),
  patchProject: (id: string, body: { name?: string; brief?: Partial<Brief>; stage?: Stage }) => req<Project>('PATCH', `/projects/${id}`, body),
  deleteProject: (id: string) => req<void>('DELETE', `/projects/${id}`),

  addAsset: (id: string, form: FormData) => req<Asset>('POST', `/projects/${id}/assets`, form),
  patchAsset: (id: string, assetId: string, body: Partial<Asset>) => req<Asset>('PATCH', `/projects/${id}/assets/${assetId}`, body),
  deleteAsset: (id: string, assetId: string) => req<void>('DELETE', `/projects/${id}/assets/${assetId}`),
  describeAsset: (id: string, assetId: string) => req<Asset>('POST', `/projects/${id}/assets/${assetId}/describe`),

  concepts: (id: string) => req<Project>('POST', `/projects/${id}/concepts`),
  selectConcept: (id: string, body: { conceptId?: string; custom?: { title: string; hook: string; angle: string; summary: string } }) =>
    req<Project>('POST', `/projects/${id}/concepts/select`, body),
  generateScript: (id: string) => req<Project>('POST', `/projects/${id}/script`),
  saveScript: (id: string, script: Script) => req<Project>('PUT', `/projects/${id}/script`, script),

  buildClips: (id: string, keepPrompts = false) => req<Project>('POST', `/projects/${id}/clips/build`, { keepPrompts }),
  patchClip: (id: string, clipId: string, body: Partial<Omit<Clip, 'captionText'>> & { captionText?: string | null }) =>
    req<Project>('PATCH', `/projects/${id}/clips/${clipId}`, body),
  rebuildClip: (id: string, clipId: string) => req<Project>('POST', `/projects/${id}/clips/${clipId}/rebuild`),
  finalPrompt: (id: string, clipId: string) => req<{ prompt: string }>('GET', `/projects/${id}/clips/${clipId}/final-prompt`),
  restoreClip: (id: string, clipId: string, version: number) => req<Project>('POST', `/projects/${id}/clips/${clipId}/restore`, { version }),
  generate: (id: string, mode: 'all' | 'one' | 'from', clipId?: string) => req<Project>('POST', `/projects/${id}/generate`, { mode, clipId }),
  cancel: (id: string) => req<Project>('POST', `/projects/${id}/cancel`),

  saveEdit: (id: string, edit: EditSettings) => req<Project>('PUT', `/projects/${id}/edit`, edit),
  render: (id: string) => req<Project>('POST', `/projects/${id}/render`),
  autopilot: (id: string) => req<Project>('POST', `/projects/${id}/autopilot`),
};
