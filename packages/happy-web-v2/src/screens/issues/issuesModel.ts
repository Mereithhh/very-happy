/**
 * B-873: pure rules behind the Issues screens (spec 2026-11-issues §10). No
 * React, no store: list/board grouping, filters, My Issues tabs, the run
 * markers, the comment trigger preview and the ⌘K match all live here so the
 * mechanism tests pin them without rendering.
 */
import {
    agentAssigneeOf,
    chooseIssueDelivery,
    ISSUE_ASSIGNABLE_AGENTS,
    ISSUE_CLOSED_STATUSES,
    ISSUE_LIMITS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    isIssueClosed,
    isIssueRunActive,
    parseIssueRef,
    routeIssueComment,
    type IssueAssigneeView,
    type IssueMention,
    type IssueRunView,
    type IssueView,
} from '@slopus/happy-wire';

/** Board / list column for a status a newer server added (spec §9: 「其他」). */
export const OTHER_STATUS = 'other';
export type IssueColumn = (typeof ISSUE_STATUSES)[number] | typeof OTHER_STATUS;

export function columnOf(status: string): IssueColumn {
    return (ISSUE_STATUSES as readonly string[]).includes(status) ? (status as IssueColumn) : OTHER_STATUS;
}

const PRIORITY_RANK: Record<string, number> = Object.fromEntries(ISSUE_PRIORITIES.map((p, i) => [p, i]));
export function priorityRank(priority: string): number {
    return PRIORITY_RANK[priority] ?? ISSUE_PRIORITIES.length;
}

/** Column order: board drag order (`sortOrder`), then newest first. */
export function compareIssues(a: IssueView, b: IssueView): number {
    return a.sortOrder - b.sortOrder || b.createdAt - a.createdAt || a.number - b.number;
}

/** Live issues (no tombstones), grouped by status in wire order, unknown statuses last. */
export function groupByStatus(issues: readonly IssueView[]): { status: IssueColumn; issues: IssueView[] }[] {
    const groups = new Map<IssueColumn, IssueView[]>();
    for (const status of [...ISSUE_STATUSES, OTHER_STATUS] as IssueColumn[]) groups.set(status, []);
    for (const issue of issues) if (!issue.deletedAt) groups.get(columnOf(issue.status))!.push(issue);
    return [...groups].map(([status, list]) => ({ status, issues: list.sort(compareIssues) }));
}

/** Fractional order between two neighbours (either may be missing) for a board drop. */
export function sortOrderBetween(before: number | null | undefined, after: number | null | undefined): number {
    if (before == null && after == null) return 0;
    if (before == null) return after! - 1;
    if (after == null) return before + 1;
    return (before + after) / 2;
}

// ─── Assignee ─────────────────────────────────────────────────────────────────

/** Filter value for an assignee: `none` / `self` / `agent:<agent>` / `other`. */
export function assigneeKey(assignee: IssueAssigneeView): string {
    if (assignee.kind === 'none' || assignee.kind === 'self') return assignee.kind;
    const agent = agentAssigneeOf(assignee);
    return agent ? `agent:${agent.agent}` : 'other';
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface IssueFilter {
    status: string[];
    projectId: string[];
    assignee: string[];
    label: string[];
    priority: string[];
    q: string;
}
export const EMPTY_FILTER: IssueFilter = { status: [], projectId: [], assignee: [], label: [], priority: [], q: '' };

export function filterActive(filter: IssueFilter): boolean {
    return filter.status.length + filter.projectId.length + filter.assignee.length + filter.label.length + filter.priority.length > 0 || filter.q.trim() !== '';
}

const NO_PROJECT = 'none';

export function matchesFilter(issue: IssueView, filter: IssueFilter): boolean {
    if (issue.deletedAt) return false;
    if (filter.status.length && !filter.status.includes(columnOf(issue.status))) return false;
    if (filter.projectId.length && !filter.projectId.includes(issue.projectId ?? NO_PROJECT)) return false;
    if (filter.assignee.length && !filter.assignee.includes(assigneeKey(issue.assignee))) return false;
    if (filter.label.length && !issue.labels.some((l) => filter.label.includes(l))) return false;
    if (filter.priority.length && !filter.priority.includes(issue.priority)) return false;
    const q = filter.q.trim().toLowerCase();
    if (q && !issue.key.toLowerCase().includes(q) && !issue.title.toLowerCase().includes(q)) return false;
    return true;
}

/** Label candidates are the values in use (spec §2: no label table). */
export function usedLabels(issues: readonly IssueView[]): string[] {
    const set = new Set<string>();
    for (const issue of issues) if (!issue.deletedAt) for (const label of issue.labels) set.add(label);
    return [...set].sort((a, b) => a.localeCompare(b));
}

/** URL ↔ filter (`/issues?assignee=none` is where `/todos` lands, spec §8). Multi-values are comma lists. */
export function filterFromSearch(search: string): IssueFilter {
    const params = new URLSearchParams(search);
    const list = (key: string) => (params.get(key) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    return { status: list('status'), projectId: list('project'), assignee: list('assignee'), label: list('label'), priority: list('priority'), q: params.get('q') ?? '' };
}
export function filterToSearch(filter: IssueFilter, extra: Record<string, string | null> = {}): string {
    const params = new URLSearchParams();
    const put = (key: string, values: string[]) => { if (values.length) params.set(key, values.join(',')); };
    put('status', filter.status);
    put('project', filter.projectId);
    put('assignee', filter.assignee);
    put('label', filter.label);
    put('priority', filter.priority);
    if (filter.q.trim()) params.set('q', filter.q.trim());
    for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export function runsOfIssue(runs: Readonly<Record<string, IssueRunView>>, issueId: string): IssueRunView[] {
    return Object.values(runs).filter((r) => r.issueId === issueId).sort((a, b) => b.seq - a.seq);
}

export function activeRun(runs: readonly IssueRunView[]): IssueRunView | null {
    return runs.find((r) => isIssueRunActive(r.status)) ?? null;
}

/** The row spinner: a run is queued, starting or in a turn (idle sessions are not "running"). */
export function runIsWorking(run: IssueRunView | null | undefined): boolean {
    return !!run && (run.status === 'queued' || run.status === 'claimed' || run.status === 'running');
}

/**
 * Spec Q7: the agent stopped (its newest run is idle or its session ended) but
 * left the issue in_progress — shown as 「agent 空闲 · 仍进行中」, never a
 * 「需要我决策」 item.
 */
export function agentIdleStillInProgress(issue: Pick<IssueView, 'status' | 'latestRunId'>, runs: readonly IssueRunView[]): boolean {
    if (issue.status !== 'in_progress') return false;
    const latest = runs.find((r) => r.id === issue.latestRunId) ?? runs[0];
    return !!latest && (latest.status === 'idle' || latest.status === 'ended');
}

/** Spec §7: a failed run without a session, not acknowledged, on an open issue — the Web merges it into 「需要我决策」. */
export function isUnackedSessionlessFailure(run: IssueRunView, issue: Pick<IssueView, 'status' | 'deletedAt'> | undefined): boolean {
    return run.status === 'failed' && run.failureAckedAt === null && !run.sessionId && !!issue && !issue.deletedAt && !isIssueClosed(issue.status);
}

export function failedRunsNeedingYou(runs: Readonly<Record<string, IssueRunView>>, issues: Readonly<Record<string, IssueView>>): IssueRunView[] {
    return Object.values(runs).filter((r) => isUnackedSessionlessFailure(r, issues[r.issueId])).sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
}

/** Sidebar badge (spec §10): my pending work = in_review + blocked. */
export function waitingOnMeCount(issues: Readonly<Record<string, IssueView>>): number {
    let n = 0;
    for (const issue of Object.values(issues)) if (!issue.deletedAt && (issue.status === 'in_review' || issue.status === 'blocked')) n++;
    return n;
}

export function runDurationMs(run: Pick<IssueRunView, 'startedAt' | 'endedAt'>, now: number): number | null {
    if (!run.startedAt) return null;
    return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

export function formatDuration(ms: number | null): string {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

// ─── My Issues ────────────────────────────────────────────────────────────────

export type MyIssuesTab = 'assigned' | 'waiting' | 'created';

/** 指派给我 = self; 等我处理 = in_review + blocked + a failed run waiting on me; 我创建的 = created by a user (not imported). */
export function myIssues(issues: readonly IssueView[], tab: MyIssuesTab, failedIssueIds: ReadonlySet<string>): IssueView[] {
    const live = issues.filter((i) => !i.deletedAt);
    const pick = tab === 'assigned'
        ? live.filter((i) => i.assignee.kind === 'self' && !isIssueClosed(i.status))
        : tab === 'waiting'
            ? live.filter((i) => i.status === 'in_review' || i.status === 'blocked' || failedIssueIds.has(i.id))
            : live.filter((i) => i.createdBy.kind === 'user');
    return pick.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Comment trigger preview (spec §6) ────────────────────────────────────────

export type TriggerPreview =
    | { kind: 'note' }
    | { kind: 'none'; reason: 'no-agent-assignee' | 'inactive-status' | 'empty' }
    | { kind: 'targets'; targets: { agent: string; machineId: string | null; mode: 'message' | 'absorbed' | 'spawn'; viaMention: boolean }[] };

/**
 * What posting this comment will do, computed with the same wire functions
 * the server enforces with (`routeIssueComment` + `chooseIssueDelivery`). A
 * session counts as live while its run is `running` / `idle` (the server knows
 * better; this is only a preview).
 */
export function commentTriggerPreview(input: {
    body: string;
    mentions: readonly IssueMention[];
    issue: Pick<IssueView, 'status' | 'assignee'>;
    runs: readonly IssueRunView[];
}): TriggerPreview {
    if (!input.body.trim()) return { kind: 'none', reason: 'empty' };
    const route = routeIssueComment({ authorKind: 'user', body: input.body, mentions: input.mentions, status: input.issue.status, assignee: input.issue.assignee });
    if (route.kind === 'none') return route.reason === 'note' ? { kind: 'note' } : { kind: 'none', reason: route.reason === 'inactive-status' ? 'inactive-status' : 'no-agent-assignee' };
    const live = new Set(input.runs.filter((r) => r.sessionId && (r.status === 'running' || r.status === 'idle')).map((r) => r.sessionId!));
    return {
        kind: 'targets',
        targets: route.targets.map((t) => {
            const delivery = chooseIssueDelivery(t, input.runs, (sid) => live.has(sid));
            return { agent: t.agent, machineId: t.machineId, mode: delivery.mode, viaMention: t.viaMention };
        }),
    };
}

export type AgentMention = Extract<IssueMention, { kind: 'agent' }>;

/** `@` picker entries: the assignable agents, on the assignee's machine by default (spec §6). */
export function mentionCandidates(issue: Pick<IssueView, 'assignee'>, fallbackMachineId: string | null): AgentMention[] {
    const machineId = agentAssigneeOf(issue.assignee)?.machineId ?? fallbackMachineId ?? undefined;
    return ISSUE_ASSIGNABLE_AGENTS.map((agent) => ({ kind: 'agent' as const, agent, ...(machineId ? { machineId } : {}) }));
}

export function toggleMention(list: readonly AgentMention[], mention: AgentMention): AgentMention[] {
    const at = list.findIndex((m) => m.agent === mention.agent);
    if (at >= 0) return list.filter((_, i) => i !== at);
    return list.length >= ISSUE_LIMITS.mentionsPerComment ? [...list] : [...list, mention];
}

// ─── ⌘K ───────────────────────────────────────────────────────────────────────

/** `VH-12` / `#12` / `12` jumps straight to that issue; otherwise key/title substring, open issues first. */
export function matchIssues(issues: readonly IssueView[], query: string, limit = 6): IssueView[] {
    const q = query.trim();
    if (!q) return [];
    const live = issues.filter((i) => !i.deletedAt);
    const ref = parseIssueRef(q);
    if (ref && 'number' in ref) {
        const exact = live.find((i) => i.number === ref.number);
        if (exact) return [exact];
    }
    const needle = q.toLowerCase();
    return live
        .filter((i) => i.key.toLowerCase().includes(needle) || i.title.toLowerCase().includes(needle))
        .sort((a, b) => Number(isIssueClosed(a.status)) - Number(isIssueClosed(b.status)) || b.updatedAt - a.updatedAt)
        .slice(0, limit);
}

export function isClosedColumn(status: IssueColumn): boolean {
    return (ISSUE_CLOSED_STATUSES as readonly string[]).includes(status);
}

/** `idOrKey` of a route param resolved against the loaded list. */
export function findIssue(issues: Readonly<Record<string, IssueView>>, idOrKey: string): IssueView | undefined {
    if (issues[idOrKey]) return issues[idOrKey];
    const ref = parseIssueRef(idOrKey);
    if (ref && 'number' in ref) return Object.values(issues).find((i) => i.number === ref.number);
    return undefined;
}

// ─── Assignee picker ──────────────────────────────────────────────────────────

/** Spec §2 IssueWorker: only machines whose issue worker polled in the last 2 minutes can take a run. */
export const ISSUE_WORKER_FRESH_MS = 2 * 60_000;

/**
 * `offline` = machine not connected; `cli-old` = connected but no fresh issue
 * worker (old CLI, or Issues just switched on and the worker is still backing
 * off). `workers === null` (list not loaded / request failed) does not block:
 * the server still refuses a machine it cannot dispatch to.
 */
export function machineWorkerState(machine: { online: boolean; machineId: string }, workers: readonly { machineId: string; lastSeenAt: number }[] | null, now: number): 'ok' | 'offline' | 'cli-old' {
    if (!machine.online) return 'offline';
    if (workers === null) return 'ok';
    const worker = workers.find((w) => w.machineId === machine.machineId);
    return worker && now - worker.lastSeenAt <= ISSUE_WORKER_FRESH_MS ? 'ok' : 'cli-old';
}
