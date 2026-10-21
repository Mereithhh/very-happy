import type { ProjectDigest, ProjectLogEntryView, ProjectPresenceEntry, ProjectSessionContext } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay } from '@/persistence';

/**
 * B-645 projects REST client for wrappers, tools and the daemon. Account
 * token, same trust level as the session (spec §2 "作者可信").
 *
 * Compatibility: an older server has no `/v1/projects*` routes (404) and a
 * gated one answers 404 `projects_disabled`. Both switch the client off for
 * `UNSUPPORTED_BACKOFF_MS` (pattern of `daemon/teams/worker.ts`), during which
 * every call fails fast with `ProjectsUnsupportedError` and wrappers simply
 * send the user's message unchanged.
 */

export const UNSUPPORTED_BACKOFF_MS = 10 * 60_000;

export class ProjectsUnsupportedError extends Error {
    constructor() { super('This Very Happy server does not support projects'); }
}
export class ProjectRequestError extends Error {
    constructor(public status: number, public code: string | null, public details: Record<string, unknown>) {
        super(code ? `Project request failed: ${code}` : `Project request failed (HTTP ${status})`);
    }
}

type Fetch = typeof fetch;
export type ProjectsClientDeps = {
    serverUrl?: string;
    token?: () => Promise<string | null>;
    fetch?: Fetch;
    now?: () => number;
};

export function createProjectsClient(deps: ProjectsClientDeps = {}) {
    const now = deps.now ?? Date.now;
    const doFetch = deps.fetch ?? fetch;
    const token = deps.token ?? (async () => (await readCredentialsForConfiguredRelay())?.token ?? null);
    let disabledUntil = 0;

    // Never propagate raw bodies into logs or errors beyond the error code.
    async function request<T>(path: string, method: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
        if (now() < disabledUntil) throw new ProjectsUnsupportedError();
        const bearer = await token();
        if (!bearer) throw new ProjectRequestError(401, 'not_signed_in', {});
        const response = await doFetch(`${deps.serverUrl ?? configuration.serverUrl}${path}`, {
            method, redirect: 'error',
            headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        let json: any = null;
        try { json = await response.json(); } catch { /* non-JSON (e.g. old server 404 page) */ }
        // Unknown route (old server: Fastify's `{ error: 'Not Found' }`) or the kill switch
        // (`projects_disabled`). A 404 naming a project object is an ordinary answer.
        if (response.status === 404 && !isProjectErrorCode(json?.error)) {
            disabledUntil = now() + UNSUPPORTED_BACKOFF_MS;
            throw new ProjectsUnsupportedError();
        }
        if (!response.ok) {
            const { error, ...details } = (json && typeof json === 'object') ? json : {} as Record<string, unknown>;
            throw new ProjectRequestError(response.status, typeof error === 'string' ? error : null, details);
        }
        return json as T;
    }
    const sid = (id: string) => encodeURIComponent(id);
    return {
        isDisabled: () => now() < disabledUntil,
        context: (sessionId: string, opts: { full?: boolean; peek?: boolean } = {}, timeoutMs?: number) =>
            request<ProjectSessionContext>(`/v1/projects/session/${sid(sessionId)}/context?full=${opts.full ? 1 : 0}&peek=${opts.peek ? 1 : 0}`, 'GET', undefined, timeoutMs),
        digest: (sessionId: string, since: number, timeoutMs?: number) =>
            request<ProjectDigest>(`/v1/projects/session/${sid(sessionId)}/digest?since=${Math.max(0, Math.floor(since))}`, 'GET', undefined, timeoutMs),
        membership: (sessionId: string) => request<{ projectId: string | null; via: string | null }>(`/v1/projects/session/${sid(sessionId)}`, 'GET'),
        note: (projectId: string, input: { kind: string; title: string; body?: string; supersedes?: string; authorSessionId: string }) =>
            request<{ entry: ProjectLogEntryView }>(`/v1/projects/${sid(projectId)}/log`, 'POST', input),
        revoke: (projectId: string, ref: string, bySessionId: string) =>
            request<{ entry: ProjectLogEntryView }>(`/v1/projects/${sid(projectId)}/log/${sid(ref)}/revoke`, 'POST', { bySessionId }),
        presence: (machineId: string, sessions: ProjectPresenceEntry[], gone?: string[]) =>
            request<{ memberships: Record<string, string> }>('/v1/projects/presence', 'PUT', { machineId, sessions, ...(gone?.length ? { gone } : {}) }),
        addMembers: (projectId: string, sessionIds: string[], via?: 'explicit' | 'lineage' | 'automation') =>
            request<{ members: unknown[] }>(`/v1/projects/${sid(projectId)}/members`, 'POST', { sessionIds, ...(via ? { via } : {}) }),
        message: (projectId: string, input: { fromSessionId: string; toSessionId: string; body: string }) =>
            request<{ stored: boolean; message: { id: string } }>(`/v1/projects/${sid(projectId)}/messages`, 'POST', input),
        delivered: (sessionId: string, messageIds: string[]) =>
            request<{ delivered: number }>('/v1/projects/messages/delivered', 'POST', { sessionId, messageIds }),
    };
}
export type ProjectsClient = ReturnType<typeof createProjectsClient>;

function isProjectErrorCode(code: unknown): boolean {
    return code === 'project_not_found' || code === 'session_not_found' || code === 'log_entry_not_found' || code === 'team_not_found';
}

let shared: ProjectsClient | null = null;
/** One client per process, so the unsupported-server backoff is shared by tools, injector and presence. */
export function sharedProjectsClient(): ProjectsClient {
    return shared ??= createProjectsClient();
}
