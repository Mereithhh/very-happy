import {
    ISSUE_ERROR_CODES, ISSUES_DISABLED_ERROR, ISSUE_WORKER_VERSION,
    type IssueCreate, type IssueCommentCreate, type IssueDetailResponse, type IssueDispatchPollResponse, type IssueDispatchView,
    type IssueListResponse, type IssueMutationResponse, type IssueSessionContext, type IssueTodoImportResult, type IssueUpdate,
} from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay } from '@/persistence';

/**
 * B-874 Issues REST client (spec 2026-11-issues §9/§13) for the CLI command,
 * the wrapper's `issue_*` tools / digest and the daemon issue worker. Account
 * token, same trust level as the session (like `projects/client.ts`).
 *
 * Compatibility: an older server has no `/v1/issues*` routes (404) and a server
 * with `VH_ISSUES_ENABLED` off answers 404 `issues_disabled`. Both switch the
 * client off for `ISSUES_UNSUPPORTED_BACKOFF_MS`, during which every call fails
 * fast with `IssuesUnsupportedError` — so the CLI falls back / says so and a
 * wrapper sends its turn unchanged. A 404 naming an issue object
 * (`issue_not_found`, …) is an ordinary answer.
 */

export const ISSUES_UNSUPPORTED_BACKOFF_MS = 10 * 60_000;

export class IssuesUnsupportedError extends Error {
    constructor() { super('This Very Happy server does not support Issues (or they are turned off).'); }
}
export class IssueRequestError extends Error {
    constructor(public status: number, public code: string | null, public details: Record<string, unknown>) {
        super(code ? `Issue request failed: ${code}` : `Issue request failed (HTTP ${status})`);
    }
}

type Fetch = typeof fetch;
export type IssuesClientDeps = {
    serverUrl?: string;
    token?: () => Promise<string | null>;
    fetch?: Fetch;
    now?: () => number;
};

const KNOWN_CODES = new Set<string>(ISSUE_ERROR_CODES.filter(code => code !== ISSUES_DISABLED_ERROR));
/** Server codes outside the wire list that still name an object (not "no such route"). */
const EXTRA_OBJECT_CODES = new Set(['issue_dispatch_not_found', 'issue_comment_not_found', 'session_not_found']);

export function isIssueObjectError(code: unknown): boolean {
    return typeof code === 'string' && (KNOWN_CODES.has(code) || EXTRA_OBJECT_CODES.has(code));
}

export function createIssuesClient(deps: IssuesClientDeps = {}) {
    const now = deps.now ?? Date.now;
    const doFetch = deps.fetch ?? fetch;
    const token = deps.token ?? (async () => (await readCredentialsForConfiguredRelay())?.token ?? null);
    let disabledUntil = 0;

    // Never propagate raw bodies into logs or errors beyond the error code (issue text is plaintext on the server).
    async function request<T>(path: string, method: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
        if (now() < disabledUntil) throw new IssuesUnsupportedError();
        const bearer = await token();
        if (!bearer) throw new IssueRequestError(401, 'not_signed_in', {});
        const response = await doFetch(`${deps.serverUrl ?? configuration.serverUrl}${path}`, {
            method, redirect: 'error',
            headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        let json: any = null;
        try { json = await response.json(); } catch { /* non-JSON (e.g. old server 404 page) */ }
        if (response.status === 404 && !isIssueObjectError(json?.error)) {
            disabledUntil = now() + ISSUES_UNSUPPORTED_BACKOFF_MS;
            throw new IssuesUnsupportedError();
        }
        if (!response.ok) {
            const { error, ...details } = (json && typeof json === 'object') ? json : {} as Record<string, unknown>;
            throw new IssueRequestError(response.status, typeof error === 'string' ? error : null, details);
        }
        return json as T;
    }
    const enc = (id: string) => encodeURIComponent(id);
    const query = (params: Record<string, string | number | undefined>) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
        const s = q.toString();
        return s ? `?${s}` : '';
    };
    return {
        isDisabled: () => now() < disabledUntil,
        // ── human / CLI ──
        list: (params: { status?: string; projectId?: string; assigneeKind?: string; q?: string; limit?: number; includeDeleted?: boolean } = {}) =>
            request<IssueListResponse>(`/v1/issues${query({ ...params, includeDeleted: params.includeDeleted ? '1' : undefined })}`, 'GET'),
        get: (ref: string) => request<IssueDetailResponse>(`/v1/issues/${enc(ref)}`, 'GET'),
        create: (input: IssueCreate) => request<IssueMutationResponse>('/v1/issues', 'POST', input),
        update: (id: string, input: IssueUpdate) => request<IssueMutationResponse>(`/v1/issues/${enc(id)}`, 'PATCH', input),
        remove: (id: string) => request<IssueMutationResponse>(`/v1/issues/${enc(id)}`, 'DELETE'),
        comment: (id: string, input: IssueCommentCreate) => request<IssueMutationResponse>(`/v1/issues/${enc(id)}/comments`, 'POST', input),
        importLegacyTodos: () => request<IssueTodoImportResult>('/v1/issues/import-legacy-todos', 'POST', {}),
        // ── wrapper (agent; the wrapper stamps its own sessionId) ──
        session: (sessionId: string, since?: number, timeoutMs?: number) =>
            request<IssueSessionContext>(`/v1/issues/session/${enc(sessionId)}${since !== undefined ? `?since=${Math.max(0, Math.floor(since))}` : ''}`, 'GET', undefined, timeoutMs),
        agentUpdate: (input: { sessionId: string; status?: string; comment?: string; requestId?: string }) =>
            request<IssueMutationResponse>('/v1/issues/agent/update', 'POST', input),
        agentComment: (input: { sessionId: string; body: string; mentionOwner?: boolean; requestId?: string }) =>
            request<IssueMutationResponse>('/v1/issues/agent/comment', 'POST', input),
        // ── daemon issue worker ──
        poll: (machineId: string) =>
            request<IssueDispatchPollResponse>(`/v1/issues/dispatch${query({ machineId, workerVersion: ISSUE_WORKER_VERSION })}`, 'GET'),
        claim: (dispatchId: string, machineId: string) =>
            request<{ dispatch: IssueDispatchView }>(`/v1/issues/dispatch/${enc(dispatchId)}/claim`, 'POST', { machineId }),
        complete: (dispatchId: string, input: { machineId: string; claimId: string; sessionId: string }) =>
            request<{ ok: true }>(`/v1/issues/dispatch/${enc(dispatchId)}/complete`, 'POST', input),
        fail: (dispatchId: string, input: { machineId: string; claimId: string; error: string; unknown?: boolean }) =>
            request<{ ok: true }>(`/v1/issues/dispatch/${enc(dispatchId)}/fail`, 'POST', input),
        sessionEvent: (runId: string, input: { machineId: string; sessionId: string; event: 'running' | 'idle' | 'exited' | 'crashed' }) =>
            request<{ ok: true }>(`/v1/issues/runs/${enc(runId)}/session-event`, 'POST', input),
    };
}
export type IssuesClient = ReturnType<typeof createIssuesClient>;

let shared: IssuesClient | null = null;
/** One client per process, so the unsupported-server backoff is shared by tools, digest and commands. */
export function sharedIssuesClient(): IssuesClient {
    return shared ??= createIssuesClient();
}

const imported = new WeakSet<object>();
/** Spec §8: a new CLI imports legacy KV Todos once per process (per client) before reading (idempotent; failures ignored). */
export async function importLegacyTodosOnce(client: Pick<IssuesClient, 'importLegacyTodos'>): Promise<void> {
    if (imported.has(client)) return;
    imported.add(client);
    await client.importLegacyTodos().catch(() => undefined);
}
