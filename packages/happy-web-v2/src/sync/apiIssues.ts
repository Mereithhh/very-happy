/**
 * B-873 (spec 2026-11-issues §9/§13): REST client for Issues (`/v1/issues*`,
 * served by the S line, B-872). Same shape as projects.ts / apiAttention.ts:
 * account token, JSON, `{ error, ...details }` bodies become `IssuesApiError`.
 *
 * Gate: `VH_ISSUES_ENABLED` off answers 404 `issues_disabled` on every route,
 * an older server 404s the unknown route — both mean "no Issues here" and the
 * Web stays exactly as before (spec §9 兼容). The transport is swappable so the
 * in-memory fake (`issuesFake.ts`) can stand in for the server in tests, the
 * DEV device harness and the e2e run until the S line is deployed.
 */
import {
    ISSUES_DISABLED_ERROR,
    type IssueCommentCreate,
    type IssueCreate,
    type IssueDetailResponse,
    type IssueListQuery,
    type IssueListResponse,
    type IssueMutationResponse,
    type IssueRunCreate,
    type IssueRunView,
    type IssueSessionContext,
    type IssueTodoImportResult,
    type IssueUpdate,
    type IssueWorkersResponse,
} from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export class IssuesApiError extends Error {
    constructor(public status: number, public code: string, public details?: Record<string, unknown>) {
        super(code);
        this.name = 'IssuesApiError';
    }
    /** Switched off (`issues_disabled`) or an older server without the route. */
    get unavailable(): boolean {
        return this.status === 404 && (this.code === ISSUES_DISABLED_ERROR || this.code === 'route_not_found');
    }
}

export function isIssuesUnavailable(error: unknown): boolean {
    return error instanceof IssuesApiError && error.unavailable;
}

export type IssuesMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** `path` is relative to `/v1/issues` (`''`, `/VH-3`, `/runs/<id>/cancel`, `?limit=1`). */
export type IssuesTransport = (method: IssuesMethod, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

const ISSUE_OBJECT_404 = new Set(['issue_not_found', 'issue_run_not_found', 'issue_project_not_found', 'issue_machine_not_found', ISSUES_DISABLED_ERROR]);

const fetchTransport: IssuesTransport = async (method, path, body) => {
    const credentials = getCurrentAuth()?.credentials;
    if (!credentials) throw new IssuesApiError(401, 'unauthorized');
    const response = await fetch(`${getServerUrl()}/v1/issues${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assertNotAuthFailure(response, 'apiIssues');
    return { status: response.status, data: await response.json().catch(() => null) };
};

let transport: IssuesTransport = fetchTransport;
/** Tests / DEV harness / e2e: answer `/v1/issues*` in-page (null restores fetch). */
export function setIssuesTransport(next: IssuesTransport | null): void {
    transport = next ?? fetchTransport;
}
export function usingFakeIssuesTransport(): boolean {
    return transport !== fetchTransport;
}

async function request<T>(method: IssuesMethod, path: string, body?: unknown): Promise<T> {
    const { status, data } = await transport(method, path, body);
    if (status < 200 || status >= 300) {
        const { error, ...details } = (data ?? {}) as { error?: string } & Record<string, unknown>;
        // Fastify's unknown-route body is `{ error: 'Not Found' }`: normalise so `unavailable` is one check.
        const code = status === 404 && (!error || !ISSUE_OBJECT_404.has(error)) ? 'route_not_found' : (error ?? `http_${status}`);
        throw new IssuesApiError(status, code, details);
    }
    if (!data || typeof data !== 'object') throw new IssuesApiError(502, 'invalid_response');
    return data as T;
}

const enc = encodeURIComponent;

export function listQueryString(query: Partial<IssueListQuery>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

export const issuesApi = {
    /** Spec §9: the Web shows Issues iff `GET /v1/issues?limit=1` answers. */
    probe: () => request<IssueListResponse>('GET', '?limit=1'),
    list: (query: Partial<IssueListQuery> = {}) => request<IssueListResponse>('GET', listQueryString(query)),
    get: (idOrKey: string) => request<IssueDetailResponse>('GET', `/${enc(idOrKey)}`),
    create: (input: IssueCreate) => request<IssueMutationResponse>('POST', '', input),
    update: (id: string, input: IssueUpdate) => request<IssueMutationResponse>('PATCH', `/${enc(id)}`, input),
    remove: (id: string) => request<IssueMutationResponse>('DELETE', `/${enc(id)}`),
    comment: (id: string, input: IssueCommentCreate) => request<IssueMutationResponse>('POST', `/${enc(id)}/comments`, input),
    run: (id: string, input: IssueRunCreate) => request<IssueMutationResponse>('POST', `/${enc(id)}/runs`, input),
    cancelRun: (runId: string) => request<{ run: IssueRunView }>('POST', `/runs/${enc(runId)}/cancel`, {}),
    ackFailure: (runId: string) => request<{ run: IssueRunView }>('POST', `/runs/${enc(runId)}/ack-failure`, {}),
    /** Spec §10 会话头: which issue a session runs for. `since=now` skips the comment digest (read-only on the server). */
    session: (sessionId: string) => request<IssueSessionContext>('GET', `/session/${enc(sessionId)}?since=${Date.now()}`),
    workers: () => request<IssueWorkersResponse>('GET', '/workers'),
    importLegacyTodos: () => request<IssueTodoImportResult>('POST', '/import-legacy-todos', {}),
};
