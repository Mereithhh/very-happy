import {
    agentAssigneeOf, ATTENTION_LIMITS, formatIssueKey, isIssueClosed, ISSUE_RUNNABLE_STATUSES,
    type IssueAssigneeView, type IssueCommentView, type IssueDispatchView, type IssueRunView, type IssueView, type ProjectFolder,
} from '@slopus/happy-wire';
import { truncateTitle } from '@/app/attention/rules';

/**
 * Pure B-872 Issues rules (`specs/2026-11-issues.md` §3/§6/§7), kept out of
 * the store so they are testable without a database. The issue-level
 * judgements (`checkAgentStatusChange`, `routeIssueComment`, …) live in
 * happy-wire; this file holds the server-only glue around them.
 *
 * Plaintext content (title / description / comment bodies / run errors) never
 * goes into a log line, metric label or thrown error message from this module
 * (spec §2.6); `issueLogSafety.spec.ts` pins that by source assertion.
 */

export class IssueError extends Error {
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}
export function requireIssue(condition: unknown, code: string, status = 409, details?: Record<string, unknown>): asserts condition {
    if (!condition) throw new IssueError(code, status, details);
}

/** Off unless exactly `true`; read on every request (same as `VH_PROJECTS_ENABLED`), so a `rollout=switch` deploy flips it. */
export function issuesEnabled(): boolean {
    return process.env.VH_ISSUES_ENABLED === 'true';
}

/** A dispatch claimed but not completed within this window goes back to the queue (spec §3.2). */
export const CLAIM_LEASE_MS = 120_000;
/** Claim expiries before the run fails. */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** A worker seen within this window counts as online (assignee picker). */
export const WORKER_ONLINE_MS = 120_000;
export const LIST_DEFAULT = 200;

// ─── Rows → views ────────────────────────────────────────────────────────────

export interface IssueRow {
    id: string; accountId: string; number: number; title: string; description: string; status: string; priority: string;
    assigneeKind: string; assignee: unknown; projectId: string | null; labels: string[]; dueAt: Date | null; parentId: string | null;
    sortOrder: number; createdBy: unknown; statusRunId: string | null; latestRunId: string | null; legacyTodoId: string | null;
    legacyTodoVersion: number | null; importedAt: Date | null; requestKey: string | null; links: unknown;
    createdAt: Date; updatedAt: Date; statusChangedAt: Date; startedAt: Date | null; completedAt: Date | null; deletedAt: Date | null; version: number;
}
export interface CommentRow {
    id: string; issueId: string; accountId: string; kind: string; authorKind: string; authorSessionId: string | null; authorRunId: string | null;
    body: string; data: unknown; mentions: unknown; refSessionId: string | null; routedRunIds: string[]; ownerAckedAt: Date | null;
    createdAt: Date; editedAt: Date | null; deletedAt: Date | null;
}
export interface RunRow {
    id: string; issueId: string; accountId: string; seq: number; trigger: string; triggerCommentId: string | null;
    agent: string; machineId: string; agentProfile: unknown; model: string | null; permissionMode: string | null; directory: string;
    status: string; sessionId: string | null; error: string | null; failureAckedAt: Date | null;
    createdAt: Date; claimedAt: Date | null; startedAt: Date | null; endedAt: Date | null;
}
export interface DispatchRow {
    id: string; accountId: string; runId: string; issueId: string; machineId: string; kind: string; payload: unknown;
    status: string; claimId: string | null; attempts: number; createdAt: Date; claimedAt: Date | null;
}

const ms = (d: Date | null | undefined) => d ? d.getTime() : null;
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function readAssignee(value: unknown): IssueAssigneeView {
    const v = record(value);
    return v && typeof v.kind === 'string' ? v as IssueAssigneeView : { kind: 'none' };
}

export function issueView(row: IssueRow): IssueView {
    const createdBy = record(row.createdBy);
    return {
        id: row.id, number: row.number, key: formatIssueKey(row.number), title: row.title, description: row.description,
        status: row.status, priority: row.priority, assignee: readAssignee(row.assignee), projectId: row.projectId, labels: row.labels,
        dueAt: ms(row.dueAt), parentId: row.parentId, sortOrder: row.sortOrder,
        createdBy: createdBy && typeof createdBy.kind === 'string' ? createdBy as IssueView['createdBy'] : { kind: 'user' },
        statusRunId: row.statusRunId, latestRunId: row.latestRunId, legacyTodoId: row.legacyTodoId,
        links: Array.isArray(row.links) ? row.links as IssueView['links'] : [],
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(), statusChangedAt: row.statusChangedAt.getTime(),
        startedAt: ms(row.startedAt), completedAt: ms(row.completedAt), deletedAt: ms(row.deletedAt), version: row.version,
    };
}

export function commentView(row: CommentRow): IssueCommentView {
    return {
        id: row.id, issueId: row.issueId, kind: row.kind,
        author: { kind: row.authorKind, sessionId: row.authorSessionId, runId: row.authorRunId },
        // A deleted comment is a tombstone: the body is not served again.
        body: row.deletedAt ? '' : row.body,
        data: record(row.data),
        mentions: Array.isArray(row.mentions) ? row.mentions as IssueCommentView['mentions'] : [],
        refSessionId: row.refSessionId, routedRunIds: row.routedRunIds, ownerAckedAt: ms(row.ownerAckedAt),
        createdAt: row.createdAt.getTime(), editedAt: ms(row.editedAt), deletedAt: ms(row.deletedAt),
    };
}

export function runView(row: RunRow): IssueRunView {
    return {
        id: row.id, issueId: row.issueId, seq: row.seq, trigger: row.trigger, triggerCommentId: row.triggerCommentId, status: row.status,
        agent: row.agent, machineId: row.machineId, agentProfile: (row.agentProfile ?? undefined) as IssueRunView['agentProfile'],
        model: row.model, permissionMode: row.permissionMode, directory: row.directory, sessionId: row.sessionId, error: row.error,
        failureAckedAt: ms(row.failureAckedAt), createdAt: row.createdAt.getTime(), claimedAt: ms(row.claimedAt),
        startedAt: ms(row.startedAt), endedAt: ms(row.endedAt),
    };
}

export interface SpawnPayload {
    agent: string; directory: string; agentProfile?: IssueRunView['agentProfile']; model?: string | null; permissionMode?: string | null;
    projectId: string | null; prompt?: string;
}
export interface MessagePayload { sessionId: string; text: string; commentId: string; trigger?: string }

/** `prompt` is filled by the caller for a spawn that has not frozen one yet (built when served, so it reads the latest comments). */
export function dispatchView(row: DispatchRow, prompt?: string): IssueDispatchView {
    const payload = record(row.payload) ?? {};
    const base = { id: row.id, kind: row.kind, issueId: row.issueId, runId: row.runId, machineId: row.machineId, claimId: row.claimId, createdAt: row.createdAt.getTime() };
    if (row.kind === 'spawn') {
        const p = payload as unknown as SpawnPayload;
        return {
            ...base,
            spawn: {
                agent: p.agent, directory: p.directory, agentProfile: p.agentProfile, model: p.model ?? null, permissionMode: p.permissionMode ?? null,
                projectId: p.projectId ?? null, prompt: p.prompt ?? prompt ?? '',
            },
        };
    }
    const p = payload as unknown as MessagePayload;
    return { ...base, message: { sessionId: p.sessionId, text: p.text, commentId: p.commentId } };
}

// ─── Assignee / directory ────────────────────────────────────────────────────

export type AgentAssignee = Extract<IssueAssigneeView, { kind: 'agent'; machineId: string; agent: string; directory?: string }>;

/** Strips undefined keys so the stored JSON (and the "same config?" comparison) is canonical. */
export function normalizeAssignee(assignee: IssueAssigneeView): IssueAssigneeView {
    if (assignee.kind !== 'agent') return assignee.kind === 'team' ? { kind: 'team', teamId: String((assignee as { teamId?: unknown }).teamId) } : { kind: assignee.kind } as IssueAssigneeView;
    const a = assignee as AgentAssignee;
    const out: Record<string, unknown> = { kind: 'agent', machineId: a.machineId, agent: a.agent };
    for (const key of ['agentProfile', 'model', 'permissionMode', 'directory', 'worktree'] as const) {
        if (a[key] !== undefined) out[key] = a[key];
    }
    return out as IssueAssigneeView;
}

/** Key-order-independent JSON (JSONB does not keep insertion order). */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Same agent configuration (machine, agent, account, model, mode, directory): reassigning to it does not start a new run. */
export function sameAgentConfig(a: IssueAssigneeView, b: IssueAssigneeView): boolean {
    if (a.kind !== 'agent' || b.kind !== 'agent') return false;
    const key = (v: IssueAssigneeView) => {
        const x = v as AgentAssignee;
        return JSON.stringify([x.machineId, x.agent, x.agentProfile ?? null, x.model ?? null, x.permissionMode ?? null, x.directory ?? null]);
    };
    return key(a) === key(b);
}

/** `assignee.directory` > the project's folder on that machine (primary first) > null (`issue_no_directory`). */
export function resolveRunDirectory(explicit: string | undefined | null, folders: readonly ProjectFolder[], machineId: string): string | null {
    if (explicit) return explicit;
    const onMachine = folders.filter(f => f.machineId === machineId);
    return (onMachine.find(f => f.primary) ?? onMachine[0])?.path ?? null;
}

/** The machine an @ without `machineId` (and not the assignee's agent) runs on: the assignee's machine, else the project's primary folder machine. */
export function defaultMentionMachine(assignee: IssueAssigneeView, folders: readonly ProjectFolder[]): string | null {
    const assigned = agentAssigneeOf(assignee);
    if (assigned) return assigned.machineId;
    return (folders.find(f => f.primary) ?? folders[0])?.machineId ?? null;
}

export function isRunnable(status: string): boolean {
    return (ISSUE_RUNNABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * §3.1 for a human PATCH: start a run (`assign`) when the issue ends up with
 * an agent assignee on a runnable status and either the agent configuration
 * changed, or the status came back from backlog / done / cancelled with no
 * active run. A changed agent supersedes the older active runs.
 */
export function planHumanUpdateRun(input: {
    before: { status: string; assignee: IssueAssigneeView };
    after: { status: string; assignee: IssueAssigneeView };
    hasActiveRun: boolean;
}): { start: false } | { start: true; supersede: boolean } {
    const { before, after } = input;
    if (after.assignee.kind !== 'agent' || !isRunnable(after.status)) return { start: false };
    const assigneeChanged = !sameAgentConfig(before.assignee, after.assignee);
    if (assigneeChanged) return { start: true, supersede: true };
    const reopened = !isRunnable(before.status);
    if (reopened && !input.hasActiveRun) return { start: true, supersede: false };
    return { start: false };
}

/** Field names a human PATCH changed besides status / assignee (those get their own timeline kinds). Names only, never values. */
export function changedFieldNames(before: IssueRow, patch: Record<string, unknown>): string[] {
    const out: string[] = [];
    const cmp: Record<string, unknown> = {
        title: before.title, description: before.description, priority: before.priority, projectId: before.projectId,
        labels: before.labels, dueAt: ms(before.dueAt), parentId: before.parentId,
    };
    for (const [key, value] of Object.entries(cmp)) {
        if (patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(value)) out.push(key);
    }
    return out;
}

// ─── Attention items (§7) ────────────────────────────────────────────────────

export const ISSUE_ATTENTION_KEYS = {
    review: (issueId: string) => `issue-review:${issueId}`,
    blocked: (issueId: string) => `issue-blocked:${issueId}`,
    runFailed: (runId: string) => `issue-run-failed:${runId}`,
    mention: (commentId: string) => `issue-mention:${commentId}`,
} as const;
export const ISSUE_REVIEW_KEY_PREFIX = 'issue-review:';
export const ISSUE_REVIEW_CHOICES = { done: 'done', return: 'return' } as const;

function clipBytes(text: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(text).length <= maxBytes) return text;
    let out = '';
    let used = encoder.encode('…').length;
    for (const ch of text) {
        const size = encoder.encode(ch).length;
        if (used + size > maxBytes) break;
        out += ch;
        used += size;
    }
    return `${out}…`;
}

type ItemIssue = Pick<IssueView, 'id' | 'key' | 'title'>;
const issueLink = (issue: ItemIssue) => [{ type: 'issue' as const, ref: issue.id, label: issue.key }];

export function reviewItem(issue: ItemIssue, delivery: string | null) {
    return {
        source: 'issue' as const, kind: 'decision' as const, key: ISSUE_ATTENTION_KEYS.review(issue.id),
        title: truncateTitle(`${issue.key} 待验收 · ${issue.title}`, ATTENTION_LIMITS.titleChars),
        bodyMd: delivery ? clipBytes(delivery, ATTENTION_LIMITS.bodyBytes) : null,
        options: [{ id: ISSUE_REVIEW_CHOICES.done, label: '完成' }, { id: ISSUE_REVIEW_CHOICES.return, label: '退回' }],
        links: issueLink(issue),
    };
}

export function blockedItem(issue: ItemIssue, missing: string | null) {
    return {
        source: 'issue' as const, kind: 'blocked' as const, key: ISSUE_ATTENTION_KEYS.blocked(issue.id),
        title: truncateTitle(`${issue.key} 卡住 · ${issue.title}`, ATTENTION_LIMITS.titleChars),
        bodyMd: missing ? clipBytes(missing, ATTENTION_LIMITS.bodyBytes) : null,
        links: issueLink(issue),
    };
}

export function runFailedItem(issue: ItemIssue, run: Pick<RunRow, 'id' | 'seq' | 'error'>) {
    return {
        source: 'issue' as const, kind: 'blocked' as const, key: ISSUE_ATTENTION_KEYS.runFailed(run.id),
        title: truncateTitle(`${issue.key} 执行失败 · ${issue.title}`, ATTENTION_LIMITS.titleChars),
        bodyMd: clipBytes(`第 ${run.seq} 次执行失败${run.error ? `：\`${run.error.slice(0, 400)}\`` : ''}\n\n在 issue 上「重试」或「换 agent」，或「知道了」。`, ATTENTION_LIMITS.bodyBytes),
        links: issueLink(issue),
    };
}

export function mentionItem(issue: ItemIssue, comment: { id: string; body: string }) {
    const first = comment.body.split('\n').find(l => l.trim())?.trim() ?? '';
    return {
        source: 'issue' as const, kind: 'todo' as const, key: ISSUE_ATTENTION_KEYS.mention(comment.id),
        title: truncateTitle(`${issue.key} @你 · ${first}`, ATTENTION_LIMITS.titleChars),
        bodyMd: clipBytes(comment.body, ATTENTION_LIMITS.bodyBytes),
        links: issueLink(issue),
    };
}

/** Which open review / blocked items a status move closes (leaving in_review / blocked, or closing the issue closes everything). */
export function attentionClosedByStatus(from: string, to: string): { review: boolean; blocked: boolean; all: boolean } {
    if (from === to) return { review: false, blocked: false, all: false };
    if (isIssueClosed(to)) return { review: true, blocked: true, all: true };
    return { review: from === 'in_review', blocked: from === 'blocked', all: false };
}

// ─── List query ──────────────────────────────────────────────────────────────

export function splitList(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    const out = value.split(',').map(s => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
}

/** Keyset cursor over `(updatedAt desc, id desc)`. */
export function encodeCursor(row: { updatedAt: Date; id: string }): string {
    return `${row.updatedAt.getTime()}:${row.id}`;
}
export function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } | null {
    if (!cursor) return null;
    const i = cursor.indexOf(':');
    const t = Number(cursor.slice(0, i));
    if (i <= 0 || !Number.isFinite(t)) return null;
    return { updatedAt: new Date(t), id: cursor.slice(i + 1) };
}

/** `VH-12` / `12` / `#12` in a search box → exact number match alongside the text match. */
export function searchNumber(q: string): number | null {
    const m = /^(?:vh-|#)?(\d{1,9})$/i.exec(q.trim());
    return m ? Number(m[1]) : null;
}
