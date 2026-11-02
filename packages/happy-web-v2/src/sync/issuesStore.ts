/**
 * B-873 (spec 2026-11-issues §10 数据层): client state for Issues. A zustand
 * store kept apart from storage.ts / sync.ts (hot zones): sync.ts only routes
 * the three socket updates here (`issue` / `issue-comment` / `issue-run`).
 *
 * `availability` is the gate the Web reads (spec §9): `GET /v1/issues?limit=1`
 * answering = on; 404 (`issues_disabled` or an older server) = off, and every
 * Issues surface stays hidden so Todos, /board, the sidebar and ⌘K look exactly
 * as before. `unknown` (not asked yet / network trouble) also renders the old
 * UI — only a positive answer switches anything.
 *
 * Freshness: full snapshots, highest `version` wins per issue; no polling —
 * socket updates while connected, `updatedSince=<asOf>` on resume (spec §9,
 * `useIssuesSync` in issuesSync.ts — kept out of here so sync.ts can import this
 * module without a cycle).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type {
    IssueCommentCreate,
    IssueCommentView,
    IssueCreate,
    IssueDetailResponse,
    IssueMutationResponse,
    IssueRunCreate,
    IssueRunView,
    IssueUpdate,
    IssueView,
} from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { issuesApi, isIssuesUnavailable, usingFakeIssuesTransport } from './apiIssues';
import { getServerUrl } from './serverConfig';

export type IssuesAvailability = 'unknown' | 'enabled' | 'disabled';

export interface IssueDetailState {
    comments: Record<string, IssueCommentView>;
    children: IssueDetailResponse['children'];
    status: 'loading' | 'ready' | 'missing' | 'error';
}

interface IssuesState {
    availability: IssuesAvailability;
    listStatus: 'idle' | 'loading' | 'ready' | 'error';
    issues: Record<string, IssueView>;
    runs: Record<string, IssueRunView>;
    details: Record<string, IssueDetailState>;
    asOf: number | null;
    workers: { machineId: string; workerVersion: number; lastSeenAt: number }[] | null;
}

const INITIAL: IssuesState = { availability: 'unknown', listStatus: 'idle', issues: {}, runs: {}, details: {}, asOf: null, workers: null };

export const useIssuesStore = create<IssuesState>(() => ({ ...INITIAL }));

// ─── merge rules (pure; exported for the mechanism tests) ─────────────────────

/** Keep the higher version (spec §9: clients keep the highest version per id). */
export function mergeIssue(map: Readonly<Record<string, IssueView>>, issue: IssueView): Record<string, IssueView> {
    const current = map[issue.id];
    if (current && current.version > issue.version) return map as Record<string, IssueView>;
    return { ...map, [issue.id]: issue };
}

const runRank = (run: IssueRunView) => [run.endedAt ?? 0, run.startedAt ?? 0, run.claimedAt ?? 0, run.failureAckedAt ?? 0];
/** Runs carry no version: a snapshot that is behind on every timestamp the server stamps is stale. */
export function mergeRun(map: Readonly<Record<string, IssueRunView>>, run: IssueRunView): Record<string, IssueRunView> {
    const current = map[run.id];
    if (current) {
        const a = runRank(current), b = runRank(run);
        const older = b.every((v, i) => v <= a[i]) && b.some((v, i) => v < a[i]);
        if (older) return map as Record<string, IssueRunView>;
    }
    return { ...map, [run.id]: run };
}

// ─── owner (server + account) ─────────────────────────────────────────────────

let owner = '';
const ownerKey = () => {
    if (usingFakeIssuesTransport()) return 'fake';
    const token = getCurrentAuth()?.credentials?.token;
    return token ? `${getServerUrl()}\0${token}` : '';
};
function ensureOwner(): string {
    const key = ownerKey();
    if (key !== owner) {
        owner = key;
        useIssuesStore.setState({ ...INITIAL });
        probing = null;
        loading = null;
        importedFor = '';
    }
    return key;
}

// ─── probe + list ─────────────────────────────────────────────────────────────

let probing: Promise<IssuesAvailability> | null = null;

/** Spec §9 gate: ask once per owner (and again on resume while still unknown). */
export function probeIssues(): Promise<IssuesAvailability> {
    const key = ensureOwner();
    if (!key) return Promise.resolve('unknown');
    const state = useIssuesStore.getState();
    if (state.availability !== 'unknown') return Promise.resolve(state.availability);
    if (probing) return probing;
    const run = issuesApi.probe().then(() => {
        if (owner === key) useIssuesStore.setState({ availability: 'enabled' });
        return 'enabled' as const;
    }).catch((error) => {
        if (owner !== key) return 'unknown' as const;
        if (isIssuesUnavailable(error)) { useIssuesStore.setState({ availability: 'disabled' }); return 'disabled' as const; }
        return 'unknown' as const;
    }).finally(() => { if (probing === run) probing = null; });
    probing = run;
    return run;
}

let loading: Promise<void> | null = null;
/** Open issues whose runs we fetch on a full load, so row spinners and failed runs are known before a socket update. */
const RUN_PREFETCH_MAX = 40;

/** Full list on first call, `updatedSince=<asOf>` afterwards (resume / reconnect). */
export function loadIssues(opts: { full?: boolean } = {}): Promise<void> {
    const key = ensureOwner();
    if (!key) return Promise.resolve();
    if (loading) return loading;
    const state = useIssuesStore.getState();
    if (state.availability === 'disabled') return Promise.resolve();
    const since = opts.full ? null : state.asOf;
    if (since === null) useIssuesStore.setState({ listStatus: state.listStatus === 'ready' ? 'ready' : 'loading' });
    const run = (async () => {
        const all: IssueView[] = [];
        let cursor: string | null = null;
        let asOf = 0;
        do {
            const page = await issuesApi.list({ limit: 500, ...(since !== null ? { updatedSince: since, includeDeleted: '1' } : {}), ...(cursor ? { cursor } : {}) });
            all.push(...page.issues);
            cursor = page.nextCursor;
            asOf = page.asOf;
        } while (cursor);
        if (owner !== key) return;
        useIssuesStore.setState((s) => ({
            availability: 'enabled',
            listStatus: 'ready',
            asOf,
            issues: all.reduce((acc, issue) => mergeIssue(acc, issue), since === null ? {} as Record<string, IssueView> : s.issues),
        }));
        if (since === null) void prefetchRuns(all, key);
    })().catch((error) => {
        if (owner !== key) return;
        if (isIssuesUnavailable(error)) useIssuesStore.setState({ ...INITIAL, availability: 'disabled' });
        else useIssuesStore.setState((s) => ({ listStatus: s.listStatus === 'ready' ? 'ready' : 'error' }));
    }).finally(() => { if (loading === run) loading = null; });
    loading = run;
    return run;
}

/**
 * The list carries no runs (wire `IssueView.latestRunId` only). Open issues
 * that ran get their detail fetched once, 4 at a time, so the row spinner,
 * 「agent 空闲 · 仍进行中」 and failed runs waiting on the owner are right
 * from the start; socket `issue-run` updates keep them fresh after that.
 */
async function prefetchRuns(issues: readonly IssueView[], key: string): Promise<void> {
    const queue = issues.filter((i) => i.latestRunId && !i.deletedAt && i.status !== 'done' && i.status !== 'cancelled')
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RUN_PREFETCH_MAX);
    const worker = async () => {
        for (let issue = queue.shift(); issue; issue = queue.shift()) {
            if (owner !== key) return;
            await loadIssueDetail(issue.id).catch(() => {});
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
}

export async function loadIssueDetail(idOrKey: string): Promise<IssueView | null> {
    const key = ensureOwner();
    if (!key) return null;
    useIssuesStore.setState((s) => ({ details: { ...s.details, [idOrKey]: s.details[idOrKey] ?? { comments: {}, children: [], status: 'loading' } } }));
    try {
        const detail = await issuesApi.get(idOrKey);
        if (owner !== key) return null;
        applyDetail(detail, idOrKey);
        return detail.issue;
    } catch (error) {
        if (owner !== key) return null;
        const missing = error instanceof Error && 'status' in error && (error as { status: number }).status === 404 && !isIssuesUnavailable(error);
        useIssuesStore.setState((s) => {
            const current = s.details[idOrKey];
            if (current?.status === 'ready') return {};
            return { details: { ...s.details, [idOrKey]: { comments: {}, children: [], status: missing ? 'missing' : 'error' } } };
        });
        if (isIssuesUnavailable(error)) useIssuesStore.setState({ availability: 'disabled' });
        return null;
    }
}

function applyDetail(detail: IssueDetailResponse, alias?: string): void {
    useIssuesStore.setState((s) => {
        const entry: IssueDetailState = {
            comments: Object.fromEntries(detail.comments.map((c) => [c.id, c])),
            children: detail.children,
            status: 'ready',
        };
        const details = { ...s.details, [detail.issue.id]: entry };
        if (alias && alias !== detail.issue.id) delete details[alias];
        return {
            issues: mergeIssue(s.issues, detail.issue),
            runs: detail.runs.reduce((acc, run) => mergeRun(acc, run), s.runs),
            details,
        };
    });
}

// ─── socket updates (sync.ts) ─────────────────────────────────────────────────

export function applyIssueUpdate(issue: IssueView): void {
    useIssuesStore.setState((s) => ({ issues: mergeIssue(s.issues, issue), ...(s.availability === 'unknown' ? { availability: 'enabled' as const } : {}) }));
}
export function applyIssueCommentUpdate(comment: IssueCommentView): void {
    useIssuesStore.setState((s) => {
        const detail = s.details[comment.issueId];
        if (!detail) return {};
        return { details: { ...s.details, [comment.issueId]: { ...detail, comments: { ...detail.comments, [comment.id]: comment } } } };
    });
}
export function applyIssueRunUpdate(run: IssueRunView): void {
    useIssuesStore.setState((s) => ({ runs: mergeRun(s.runs, run) }));
}

function applyMutation(result: IssueMutationResponse): IssueView {
    useIssuesStore.setState((s) => {
        let details = s.details;
        if (result.comment) {
            const d = details[result.comment.issueId];
            if (d) details = { ...details, [result.comment.issueId]: { ...d, comments: { ...d.comments, [result.comment.id]: result.comment } } };
        }
        return {
            issues: mergeIssue(s.issues, result.issue),
            runs: (result.runs ?? []).reduce((acc, run) => mergeRun(acc, run), s.runs),
            details,
        };
    });
    return result.issue;
}

// ─── mutations ────────────────────────────────────────────────────────────────

export async function createIssue(input: IssueCreate): Promise<IssueView> {
    return applyMutation(await issuesApi.create(input));
}
export async function updateIssue(id: string, patch: IssueUpdate): Promise<IssueView> {
    const issue = applyMutation(await issuesApi.update(id, patch));
    // System timeline entries (status / assign / field) are written by the server; refresh an open detail.
    if (useIssuesStore.getState().details[id]?.status === 'ready') void loadIssueDetail(id);
    return issue;
}
export async function deleteIssue(id: string): Promise<void> {
    applyMutation(await issuesApi.remove(id));
}
export async function commentOnIssue(id: string, input: IssueCommentCreate): Promise<void> {
    applyMutation(await issuesApi.comment(id, input));
}
export async function startIssueRun(id: string, input: IssueRunCreate): Promise<void> {
    applyMutation(await issuesApi.run(id, input));
}
export async function cancelIssueRun(runId: string): Promise<void> {
    const { run } = await issuesApi.cancelRun(runId);
    applyIssueRunUpdate(run);
}
export async function ackIssueRunFailure(runId: string): Promise<void> {
    const { run } = await issuesApi.ackFailure(runId);
    applyIssueRunUpdate(run);
}

/** In-review decision (spec §7): 完成 → done; 退回 → todo, the note becomes a human comment (routed back to the agent). */
export async function acceptIssue(id: string): Promise<void> {
    await updateIssue(id, { status: 'done' });
}
export async function returnIssue(id: string, note: string): Promise<void> {
    await updateIssue(id, { status: 'todo' });
    if (note.trim()) await commentOnIssue(id, { body: note.trim() });
}

export async function loadIssueWorkers(): Promise<void> {
    try {
        const { workers } = await issuesApi.workers();
        useIssuesStore.setState({ workers });
    } catch {
        // Unknown stays null: the picker does not block on a failed read (the server refuses what it cannot dispatch).
    }
}

let importedFor = '';
/** Spec §8: the Issues page imports legacy Todos once per mount/owner (idempotent server-side). */
export function importLegacyTodosOnce(): void {
    const key = ensureOwner();
    if (!key || importedFor === key) return;
    importedFor = key;
    void issuesApi.importLegacyTodos().then((result) => {
        if (result.imported || result.updated || result.conflicts) void loadIssues();
    }).catch(() => { importedFor = ''; });
}

// ─── hooks ────────────────────────────────────────────────────────────────────

export function useIssuesAvailability(): IssuesAvailability {
    useEffect(() => { void probeIssues(); }, []);
    return useIssuesStore((s) => (owner === ownerKey() ? s.availability : 'unknown'));
}
export function useIssuesEnabled(): boolean {
    return useIssuesAvailability() === 'enabled';
}

export const _forTests = {
    reset: () => { owner = ''; probing = null; loading = null; importedFor = ''; useIssuesStore.setState({ ...INITIAL }); },
};
