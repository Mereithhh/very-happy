/**
 * B-647/B-648: REST client and shared snapshot for Projects (B-644,
 * `specs/2026-10-projects.md`). Same shape as `apiAutomations.ts` / `teams.ts`:
 * account token, JSON, `{ error }` bodies become `ProjectsApiError`.
 *
 * Compatibility: an older server has no `/v1/projects` route and a gated one
 * answers 404 `projects_disabled`; both mean "projects unavailable" — the
 * sidebar then shows every session under 未归属 by folder (the old workspace
 * grouping), never an error.
 */
import { useSyncExternalStore } from 'react';
import type {
  ProjectCreate, ProjectDetailResponse, ProjectInstructionsRevisionView, ProjectListResponse, ProjectLogEntryView, ProjectMemberView,
  ProjectUpdate, ProjectView, ProjectLogKind,
} from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { sync } from './sync';
import { ProjectsApiError } from './projectsError';

export { ProjectsApiError };

const PROJECT_OBJECT_404 = new Set(['project_not_found', 'session_not_found', 'log_entry_not_found', 'team_not_found']);

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const credentials = getCurrentAuth()?.credentials;
  if (!credentials) throw new ProjectsApiError(401, 'unauthorized');
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${getServerUrl()}/v1/projects${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'X-Happy-Client': getHappyClientId(),
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  assertNotAuthFailure(response, 'apiProjects');
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const { error, ...details } = (data ?? {}) as { error?: string } & Record<string, unknown>;
    // Fastify's unknown-route body is `{ error: 'Not Found' }` — normalise it so `unavailable` is one check.
    const code = response.status === 404 && (!error || !PROJECT_OBJECT_404.has(error)) && error !== 'projects_disabled' ? 'route_not_found' : (error ?? `http_${response.status}`);
    throw new ProjectsApiError(response.status, code, details);
  }
  if (!data || typeof data !== 'object') throw new ProjectsApiError(502, 'invalid_response');
  return data as T;
}

const id = (value: string) => encodeURIComponent(value);
export const projectsApi = {
  list: (includeArchived = false) => request<ProjectListResponse>(includeArchived ? '?includeArchived=1' : ''),
  get: (projectId: string) => request<ProjectDetailResponse>(`/${id(projectId)}`),
  create: (input: ProjectCreate) => request<{ project: ProjectView }>('', { body: input }),
  update: (projectId: string, input: ProjectUpdate) => request<{ project: ProjectView }>(`/${id(projectId)}`, { method: 'PATCH', body: input }),
  remove: (projectId: string) => request<{ ok: true }>(`/${id(projectId)}`, { method: 'DELETE' }),
  putInstructions: (projectId: string, input: { instructions: string; ifVersion: number; summary?: string }) =>
    request<{ project: ProjectView }>(`/${id(projectId)}/instructions`, { method: 'PUT', body: input }),
  history: (projectId: string) => request<{ revisions: ProjectInstructionsRevisionView[] }>(`/${id(projectId)}/instructions/history`),
  addMembers: (projectId: string, sessionIds: string[], via?: 'explicit' | 'suggested-accepted') =>
    request<{ members: ProjectMemberView[] }>(`/${id(projectId)}/members`, { body: { sessionIds, ...(via ? { via } : {}) } }),
  removeMember: (projectId: string, sessionId: string) => request<{ removed: boolean }>(`/${id(projectId)}/members/${id(sessionId)}`, { method: 'DELETE' }),
  attachTeam: (projectId: string, teamId: string) => request<{ teamId: string; projectId: string }>(`/${id(projectId)}/attach-team`, { body: { teamId } }),
  detachTeam: (projectId: string, teamId: string) => request<{ detached: boolean }>(`/${id(projectId)}/detach-team`, { body: { teamId } }),
  addLog: (projectId: string, input: { kind: ProjectLogKind; title: string; body?: string; supersedes?: string }) =>
    request<{ entry: ProjectLogEntryView }>(`/${id(projectId)}/log`, { body: input }),
  revokeLog: (projectId: string, entryId: string) => request<{ entry: ProjectLogEntryView }>(`/${id(projectId)}/log/${id(entryId)}/revoke`, { body: {} }),
};

// ─── shared list snapshot (sidebar, palette, pickers) ─────────────────────

export type ProjectsSnapshot = {
  /** false until the first answer; `unavailable` = old server / switched off. */
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  projects: ProjectView[];
  members: ProjectMemberView[];
};
const EMPTY: ProjectsSnapshot = { status: 'loading', projects: [], members: [] };
let snapshot: ProjectsSnapshot = EMPTY;
let owner = '';
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const ownerKey = () => {
  const token = getCurrentAuth()?.credentials?.token;
  return token ? `${getServerUrl()}\0${token}` : '';
};

/** Re-read the list; mutations call it so every surface sees the change at once. */
export function refreshProjects(): Promise<void> {
  const key = ownerKey();
  if (key !== owner) { owner = key; snapshot = EMPTY; pending = null; notify(); }
  if (!key) return Promise.resolve();
  if (pending) return pending;
  const run = projectsApi.list().then(({ projects, members }) => {
    if (owner === key) { snapshot = { status: 'ready', projects, members }; notify(); }
  }).catch((error) => {
    if (owner !== key) return;
    // Keep the last good list on a transient failure; only "unavailable" clears it.
    if (error instanceof ProjectsApiError && error.unavailable) snapshot = { status: 'unavailable', projects: [], members: [] };
    else if (snapshot.status === 'loading') snapshot = { ...snapshot, status: 'error' };
    notify();
  }).finally(() => { if (pending === run) pending = null; });
  pending = run;
  return run;
}

let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribeResume: (() => void) | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refreshProjects();
    // Optional-call: some test harnesses mock `sync` without onResume; polling still covers resume.
    unsubscribeResume = typeof sync.onResume === 'function' ? sync.onResume(() => { void refreshProjects(); }) : undefined;
    timer = setInterval(() => { if (!document.hidden) void refreshProjects(); }, 20_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; unsubscribeResume?.(); unsubscribeResume = undefined; }
  };
}
/** DEV harness only (`/dev/sidebar`): serve a fixed snapshot without a server. */
let devOverride: ProjectsSnapshot | null = null;
export function setProjectsDevOverride(next: ProjectsSnapshot | null): void { devOverride = next; notify(); }
const getSnapshot = () => devOverride ?? (owner === ownerKey() ? snapshot : EMPTY);
/** Imperative read of the same snapshot (no fetch) for one-shot callers such as the archive landing. */
export function projectsSnapshot(): ProjectsSnapshot { return getSnapshot(); }
export function useProjects(): ProjectsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** Optimistically apply a membership change to the snapshot (the next refresh confirms it). */
export function applyLocalMembership(projectId: string | null, sessionIds: string[]): void {
  if (snapshot.status !== 'ready') return;
  const moved = new Set(sessionIds);
  const members = snapshot.members.filter(m => !moved.has(m.sessionId));
  if (projectId) for (const sessionId of sessionIds) members.push({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: Date.now() });
  snapshot = { ...snapshot, members };
  notify();
}

export const _forTests = { reset: () => { snapshot = EMPTY; owner = ''; pending = null; } };
