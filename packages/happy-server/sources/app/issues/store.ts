import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    agentAssigneeOf, buildIssueCommentPrompt, buildIssueInitialPrompt, checkAgentStatusChange, chooseIssueDelivery, isIssueClosed, isIssueRunActive,
    issueStatusAfterRunFailure, issueStatusOnRunStart, ISSUE_LIMITS, ISSUE_RUN_ACTIVE_STATUSES, parseIssueRef, routeIssueComment,
    type IssueAgentComment, type IssueAgentUpdate, type IssueAssigneeView, type IssueCommentCreate, type IssueCreate, type IssueDetailResponse,
    type IssueListQuery, type IssueListResponse, type IssueMention, type IssueMutationResponse, type IssueRunCreate, type IssueRunView,
    type IssueSessionContext, type IssueUpdate, type IssueView, type ProjectFolder,
} from '@slopus/happy-wire';
import { buildIssueCommentUpdate, buildIssueRunUpdate, buildIssueUpdate, eventRouter } from '@/app/events/eventRouter';
import { readFolders } from '@/app/projects/rules';
import { afterTx, inTx, isRetryableTransactionConflict, type Tx } from '@/storage/inTx';
import { allocateUserSeq } from '@/storage/seq';
import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { bridgeAgentStatus, bridgeOwnerMention, bridgeOwnerMentionsHandled, bridgeRunFailed, bridgeRunFailuresCleared, bridgeStatusLeft } from './attentionBridge';
import {
    canonicalJson, changedFieldNames, commentView, decodeCursor, defaultMentionMachine, encodeCursor, isRunnable, IssueError, issuesEnabled, issueView,
    LIST_DEFAULT, normalizeAssignee, planHumanUpdateRun, readAssignee, requireIssue, resolveRunDirectory, runView, searchNumber, splitList,
    ISSUE_REVIEW_CHOICES, type AgentAssignee, type CommentRow, type IssueRow, type MessagePayload, type RunRow, type SpawnPayload,
} from './rules';

/**
 * B-872 Issues store (`specs/2026-11-issues.md` §2–§8). Every mutation runs
 * in a SERIALIZABLE `inTx` (P2034 / P2010+40001 retried there, AGENTS rule
 * 12; a racing unique insert — P2002 — is retried here); exhausted retries
 * surface as a retryable 409 `transaction_conflict`. After commit each
 * changed issue / comment / run is emitted once as an account-level update
 * (full snapshot, highest version wins on the client).
 *
 * Content is plaintext server-side (§2.6) and never logged: the only log line
 * here is a fixed message on an emit failure.
 */

export function assertIssuesEnabled() {
    requireIssue(issuesEnabled(), 'issues_disabled', 404);
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const requestKey = (scope: string, accountId: string, requestId: string | undefined) => requestId ? hash(`issue-${scope}:${accountId}:${requestId}`) : null;
const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const json = (value: unknown) => value as Prisma.InputJsonValue;

export async function runIssueTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertIssuesEnabled();
    for (let attempt = 0; ; attempt++) {
        try { return await inTx(fn); }
        catch (error) {
            if (isUniqueViolation(error) && attempt < 3) continue;
            if (isRetryableTransactionConflict(error) || isUniqueViolation(error)) throw new IssueError('transaction_conflict', 409);
            throw error;
        }
    }
}

// ─── Emission (once per object per transaction, after commit) ────────────────

const pendingSymbol = Symbol('issue-emits');
type Pending = Map<string, { accountId: string; build: (seq: number, id: string) => ReturnType<typeof buildIssueUpdate> }>;

function queueEmit(tx: Tx, key: string, accountId: string, build: (seq: number, id: string) => ReturnType<typeof buildIssueUpdate>) {
    let pending = (tx as any)[pendingSymbol] as Pending | undefined;
    if (!pending) {
        pending = new Map();
        (tx as any)[pendingSymbol] = pending;
        const flush = pending;
        afterTx(tx, () => { void emitAll(flush); });
    }
    pending.set(key, { accountId, build });
}
async function emitAll(pending: Pending) {
    for (const { accountId, build } of pending.values()) {
        try {
            const seq = await allocateUserSeq(accountId);
            eventRouter.emitUpdate({ userId: accountId, payload: build(seq, randomKeyNaked(12)), recipientFilter: { type: 'user-scoped-only' } });
        } catch (error) {
            log({ module: 'issues', level: 'warn', error }, 'issue update emit failed');
        }
    }
}
export function emitIssue(tx: Tx, row: IssueRow) {
    const view = issueView(row);
    queueEmit(tx, `issue:${row.id}`, row.accountId, (seq, id) => buildIssueUpdate(view, seq, id));
}
export function emitComment(tx: Tx, row: CommentRow) {
    const view = commentView(row);
    queueEmit(tx, `comment:${row.id}`, row.accountId, (seq, id) => buildIssueCommentUpdate(view, seq, id));
}
export function emitRun(tx: Tx, row: RunRow) {
    const view = runView(row);
    queueEmit(tx, `run:${row.id}`, row.accountId, (seq, id) => buildIssueRunUpdate(view, seq, id));
}

// ─── Loading / validation ────────────────────────────────────────────────────

export async function loadIssue(tx: Tx, accountId: string, ref: string, opts: { allowDeleted?: boolean } = {}): Promise<IssueRow> {
    const parsed = parseIssueRef(ref);
    requireIssue(parsed, 'issue_not_found', 404);
    const row = await tx.issue.findFirst({ where: 'number' in parsed ? { accountId, number: parsed.number } : { accountId, id: parsed.id } });
    requireIssue(row && (opts.allowDeleted || !row.deletedAt), 'issue_not_found', 404);
    return row;
}

async function projectFolders(tx: Tx, accountId: string, projectId: string | null): Promise<ProjectFolder[]> {
    if (!projectId) return [];
    const project = await tx.project.findFirst({ where: { id: projectId, accountId }, select: { folders: true } });
    requireIssue(project, 'issue_project_not_found', 404);
    return readFolders(project.folders);
}

async function requireMachine(tx: Tx, accountId: string, machineId: string) {
    requireIssue(await tx.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } }), 'issue_machine_not_found', 404, { machineId });
}

/** team → unsupported in phase 1; agent → machine of this account and a resolvable directory (refused now, not after queueing). */
async function validateAssignee(tx: Tx, accountId: string, assignee: IssueAssigneeView, folders: ProjectFolder[]): Promise<IssueAssigneeView> {
    if (assignee.kind === 'team') throw new IssueError('issue_assignee_unsupported', 400);
    const agent = agentAssigneeOf(assignee);
    if (agent) {
        await requireMachine(tx, accountId, agent.machineId);
        requireIssue(resolveRunDirectory((assignee as AgentAssignee).directory, folders, agent.machineId), 'issue_no_directory', 400, { machineId: agent.machineId });
    }
    return normalizeAssignee(assignee);
}

/** Parent must be a live issue of this account; the chain above it may not contain `selfId` nor exceed the depth limit. */
async function checkParent(tx: Tx, accountId: string, selfId: string | null, parentId: string): Promise<void> {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
        requireIssue(cursor !== selfId && depth < ISSUE_LIMITS.parentDepth, 'issue_parent_cycle', 400);
        const row: { parentId: string | null; deletedAt: Date | null } | null = await tx.issue.findFirst({ where: { id: cursor, accountId }, select: { parentId: true, deletedAt: true } });
        requireIssue(row && (depth > 0 || !row.deletedAt), 'issue_not_found', 404, { parentId });
        cursor = row.parentId;
    }
}

async function allocateNumber(tx: Tx, accountId: string): Promise<number> {
    const seq = await tx.issueSequence.upsert({ where: { accountId }, create: { accountId, last: 1 }, update: { last: { increment: 1 } } });
    return seq.last;
}

async function enforceIssueQuota(tx: Tx, accountId: string, adding = 1) {
    const count = await tx.issue.count({ where: { accountId, deletedAt: null } });
    requireIssue(count + adding <= ISSUE_LIMITS.issuesPerAccount, 'issue_count_quota_exceeded', 429, { limit: ISSUE_LIMITS.issuesPerAccount });
}

async function updateIssue(tx: Tx, id: string, data: Prisma.IssueUpdateInput): Promise<IssueRow> {
    const row = await tx.issue.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedAt: new Date() } });
    emitIssue(tx, row);
    return row;
}

async function addTimeline(tx: Tx, issue: Pick<IssueRow, 'id' | 'accountId'>, entry: {
    kind: string; authorKind: string; body: string; data?: Record<string, unknown> | null;
    authorSessionId?: string | null; authorRunId?: string | null; mentions?: unknown[]; refSessionId?: string | null; requestKey?: string | null;
}): Promise<CommentRow> {
    const row = await tx.issueComment.create({ data: {
        id: randomUUID(), issueId: issue.id, accountId: issue.accountId, kind: entry.kind, authorKind: entry.authorKind, body: entry.body,
        data: entry.data ? json(entry.data) : Prisma.DbNull, mentions: json(entry.mentions ?? []), authorSessionId: entry.authorSessionId ?? null,
        authorRunId: entry.authorRunId ?? null, refSessionId: entry.refSessionId ?? null, requestKey: entry.requestKey ?? null,
    } });
    emitComment(tx, row);
    return row;
}

const statusEntry = (from: string, to: string) => ({ kind: 'status', body: `${from} → ${to}`, data: { from, to } });

async function activeRuns(tx: Tx, issueId: string): Promise<RunRow[]> {
    return tx.issueRun.findMany({ where: { issueId, status: { in: [...ISSUE_RUN_ACTIVE_STATUSES] } }, orderBy: { createdAt: 'asc' } });
}

async function liveSessions(tx: Tx, accountId: string, sessionIds: string[]): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();
    const rows = await tx.session.findMany({ where: { accountId, id: { in: sessionIds }, active: true, archivedAt: null }, select: { id: true } });
    return new Set(rows.map(r => r.id));
}

// ─── Runs ────────────────────────────────────────────────────────────────────

/** Recent prose comments + the trigger comment → the run's first message (spec §3.3). Built when served, so it reads comments added while queued. */
export async function buildRunPrompt(tx: Tx, issue: IssueRow, run: Pick<RunRow, 'trigger' | 'triggerCommentId'>): Promise<string> {
    const rows = await tx.issueComment.findMany({ where: { issueId: issue.id, kind: 'comment', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: ISSUE_LIMITS.contextComments });
    const comments = rows.reverse().map(commentView);
    const trigger = run.triggerCommentId ? comments.find(c => c.id === run.triggerCommentId)
        ?? (await tx.issueComment.findFirst({ where: { id: run.triggerCommentId } }).then(r => r ? commentView(r) : null)) : null;
    return buildIssueInitialPrompt({ issue: issueView(issue), comments, trigger: run.trigger, triggerComment: trigger });
}

async function endRun(tx: Tx, run: RunRow, status: 'ended' | 'cancelled' | 'superseded'): Promise<RunRow> {
    const updated = await tx.issueRun.update({ where: { id: run.id }, data: { status, endedAt: new Date() } });
    await tx.issueDispatch.updateMany({ where: { runId: run.id, status: 'queued' }, data: { status: 'cancelled', doneAt: new Date() } });
    emitRun(tx, updated);
    return updated;
}

/**
 * New run + its spawn dispatch (queued). Earlier failures of the issue count
 * as handled (spec §7: a new run clears 执行失败). `supersede` ends the
 * issue's other active runs (retry / another agent, §3.1, §3.6).
 */
export async function createRunTx(tx: Tx, issue: IssueRow, input: {
    trigger: string; triggerCommentId?: string | null; config: AgentAssignee; directory: string; supersede: boolean; requestKey?: string | null;
}): Promise<{ run: RunRow; issue: IssueRow }> {
    if (input.supersede) for (const run of await activeRuns(tx, issue.id)) await endRun(tx, run, 'superseded');
    const failed = await tx.issueRun.findMany({ where: { issueId: issue.id, status: 'failed', failureAckedAt: null }, select: { id: true } });
    if (failed.length) {
        const now = new Date();
        for (const f of failed) emitRun(tx, await tx.issueRun.update({ where: { id: f.id }, data: { failureAckedAt: now } }));
        await bridgeRunFailuresCleared(tx, issue.accountId, failed.map(f => f.id), 'issue-status');
    }
    const last = await tx.issueRun.findFirst({ where: { issueId: issue.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const c = input.config;
    const run = await tx.issueRun.create({ data: {
        id: randomUUID(), issueId: issue.id, accountId: issue.accountId, seq: (last?.seq ?? 0) + 1, trigger: input.trigger,
        triggerCommentId: input.triggerCommentId ?? null, agent: c.agent, machineId: c.machineId,
        agentProfile: c.agentProfile === undefined ? Prisma.DbNull : c.agentProfile === null ? Prisma.JsonNull : json(c.agentProfile),
        model: c.model ?? null, permissionMode: c.permissionMode ?? null, directory: input.directory, status: 'queued', requestKey: input.requestKey ?? null,
    } });
    const payload: SpawnPayload = {
        agent: c.agent, directory: input.directory, ...(c.agentProfile !== undefined ? { agentProfile: c.agentProfile } : {}),
        model: c.model ?? null, permissionMode: c.permissionMode ?? null, projectId: issue.projectId,
    };
    await tx.issueDispatch.create({ data: {
        id: randomUUID(), accountId: issue.accountId, runId: run.id, issueId: issue.id, machineId: c.machineId, kind: 'spawn', payload: json(payload), status: 'queued',
    } });
    emitRun(tx, run);
    const updated = await updateIssue(tx, issue.id, { latestRunId: run.id });
    return { run, issue: updated };
}

/** The agent assignee as a run configuration with its directory resolved (null when it cannot be). */
function runConfig(assignee: IssueAssigneeView, folders: ProjectFolder[]): { config: AgentAssignee; directory: string } | null {
    const agent = agentAssigneeOf(assignee);
    if (!agent) return null;
    const config = assignee as AgentAssignee;
    const directory = resolveRunDirectory(config.directory, folders, agent.machineId);
    return directory ? { config, directory } : null;
}

/**
 * Run reached `running` (spawn completed): `todo → in_progress` by the system
 * on behalf of this run (§3.4), anything else untouched.
 */
export async function onRunStartedTx(tx: Tx, issue: IssueRow, run: RunRow): Promise<IssueRow> {
    const next = issueStatusOnRunStart(issue.status);
    if (next === issue.status) return issue.startedAt ? issue : updateIssue(tx, issue.id, { startedAt: new Date() });
    const now = new Date();
    const updated = await updateIssue(tx, issue.id, { status: next, statusRunId: run.id, statusChangedAt: now, startedAt: issue.startedAt ?? now });
    await addTimeline(tx, issue, { ...statusEntry(issue.status, next), authorKind: 'system', authorRunId: run.id });
    return updated;
}

/**
 * §3.7: run → failed; the issue's in_progress goes back to todo only if this
 * run caused it; a failure with a session becomes a 「需要我决策」 item (one
 * without is merged by the Web from `failed && failureAckedAt == null`).
 */
export async function failRunTx(tx: Tx, run: RunRow, error: string): Promise<void> {
    if (!isIssueRunActive(run.status)) return;
    const failed = await tx.issueRun.update({ where: { id: run.id }, data: { status: 'failed', error: error.slice(0, 4000), endedAt: new Date() } });
    await tx.issueDispatch.updateMany({ where: { runId: run.id, status: 'queued' }, data: { status: 'cancelled', doneAt: new Date() } });
    emitRun(tx, failed);
    let issue = await tx.issue.findUniqueOrThrow({ where: { id: run.issueId } });
    await addTimeline(tx, issue, { kind: 'run', authorKind: 'system', authorRunId: run.id, body: `run ${run.seq} failed`, data: { runId: run.id, seq: run.seq, status: 'failed' } });
    const next = issueStatusAfterRunFailure(issue, run.id);
    if (next !== issue.status) {
        await addTimeline(tx, issue, { ...statusEntry(issue.status, next), authorKind: 'system', authorRunId: run.id });
        issue = await updateIssue(tx, issue.id, { status: next, statusRunId: null, statusChangedAt: new Date() });
    }
    if (!issue.deletedAt && !isIssueClosed(issue.status)) await bridgeRunFailed(tx, issue.accountId, issueView(issue), failed);
}

/**
 * A `message` dispatch failed (the daemon found the session not live): that
 * run is over, and the comment starts a new run of the same configuration.
 */
export async function respawnForCommentTx(tx: Tx, run: RunRow, payload: MessagePayload): Promise<void> {
    if (run.status === 'running' || run.status === 'idle') await endRun(tx, run, 'ended');
    const issue = await tx.issue.findUniqueOrThrow({ where: { id: run.issueId } });
    if (issue.deletedAt) return;
    // Another delivery already started a newer run of this agent: the comment reaches it through that run's prompt.
    const newer = await tx.issueRun.findFirst({ where: { issueId: issue.id, agent: run.agent, machineId: run.machineId, status: { in: [...ISSUE_RUN_ACTIVE_STATUSES] }, createdAt: { gt: run.createdAt } } });
    if (newer) return;
    const config: AgentAssignee = {
        kind: 'agent', agent: run.agent, machineId: run.machineId,
        ...(run.agentProfile !== null ? { agentProfile: run.agentProfile as AgentAssignee['agentProfile'] } : {}),
        model: run.model, permissionMode: run.permissionMode, directory: run.directory,
    };
    const started = await createRunTx(tx, issue, { trigger: payload.trigger ?? 'comment', triggerCommentId: payload.commentId, config, directory: run.directory, supersede: false });
    const comment = await tx.issueComment.findUnique({ where: { id: payload.commentId } });
    if (comment) emitComment(tx, await tx.issueComment.update({ where: { id: comment.id }, data: { routedRunIds: [...comment.routedRunIds, started.run.id] } }));
}

// ─── Human: list / read ──────────────────────────────────────────────────────

export async function listIssues(accountId: string, query: IssueListQuery): Promise<IssueListResponse> {
    return runIssueTx(async tx => {
        const asOf = Date.now();
        const limit = query.limit ?? LIST_DEFAULT;
        const statuses = splitList(query.status);
        const priorities = splitList(query.priority);
        const includeDeleted = query.updatedSince !== undefined || query.includeDeleted === '1' || query.includeDeleted === 'true';
        const q = query.q?.trim();
        const number = q ? searchNumber(q) : null;
        const cursor = decodeCursor(query.cursor);
        const and: Prisma.IssueWhereInput[] = [];
        if (q) and.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }, ...(number ? [{ number }] : [])] });
        if (cursor) and.push({ OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }] });
        const rows = await tx.issue.findMany({
            where: {
                accountId,
                ...(includeDeleted ? {} : { deletedAt: null }),
                ...(statuses ? { status: { in: statuses } } : {}),
                ...(priorities ? { priority: { in: priorities } } : {}),
                ...(query.projectId ? { projectId: query.projectId } : {}),
                ...(query.assigneeKind ? { assigneeKind: query.assigneeKind } : {}),
                ...(query.label ? { labels: { has: query.label } } : {}),
                // Inclusive: an update in the same millisecond as the previous asOf is returned again rather than missed.
                ...(query.updatedSince !== undefined ? { updatedAt: { gte: new Date(query.updatedSince) } } : {}),
                ...(and.length ? { AND: and } : {}),
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
        });
        const page = rows.slice(0, limit);
        return { issues: page.map(issueView), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null, asOf };
    });
}

export async function getIssue(accountId: string, ref: string): Promise<IssueDetailResponse> {
    return runIssueTx(async tx => {
        const issue = await loadIssue(tx, accountId, ref, { allowDeleted: true });
        const comments = await tx.issueComment.findMany({ where: { issueId: issue.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const runs = await tx.issueRun.findMany({ where: { issueId: issue.id }, orderBy: { seq: 'asc' } });
        const children = await tx.issue.findMany({ where: { accountId, parentId: issue.id, deletedAt: null }, orderBy: { number: 'asc' }, select: { id: true, number: true, title: true, status: true } });
        return {
            issue: issueView(issue), comments: comments.map(commentView), runs: runs.map(runView),
            children: children.map(c => ({ id: c.id, key: `VH-${c.number}`, title: c.title, status: c.status })),
        };
    });
}

// ─── Human: create / update / delete ─────────────────────────────────────────

/** POST /v1/issues. Idempotent by `requestId`; an agent assignee on a runnable status starts a run in the same transaction (§3.1). */
export async function createIssue(accountId: string, input: IssueCreate): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const key = requestKey('create', accountId, input.requestId);
        if (key) {
            const prior = await tx.issue.findFirst({ where: { requestKey: key, accountId } });
            if (prior) return { issue: issueView(prior), runs: (await tx.issueRun.findMany({ where: { issueId: prior.id }, orderBy: { seq: 'asc' } })).map(runView) };
        }
        await enforceIssueQuota(tx, accountId);
        const projectId = input.projectId ?? null;
        const folders = await projectFolders(tx, accountId, projectId);
        const assignee = await validateAssignee(tx, accountId, input.assignee ?? { kind: 'none' }, folders);
        if (input.parentId) await checkParent(tx, accountId, null, input.parentId);
        const status = input.status ?? (assignee.kind === 'agent' ? 'todo' : 'backlog');
        const now = new Date();
        let issue: IssueRow = await tx.issue.create({ data: {
            id: randomUUID(), accountId, number: await allocateNumber(tx, accountId), title: input.title, description: input.description ?? '',
            status, priority: input.priority ?? 'none', assigneeKind: assignee.kind, assignee: json(assignee), projectId, labels: input.labels ?? [],
            dueAt: input.dueAt ? new Date(input.dueAt) : null, parentId: input.parentId ?? null, sortOrder: now.getTime(),
            createdBy: json({ kind: 'user' }), requestKey: key, createdAt: now, updatedAt: now, statusChangedAt: now,
            completedAt: isIssueClosed(status) ? now : null,
        } });
        emitIssue(tx, issue);
        const runs: IssueRunView[] = [];
        const cfg = isRunnable(status) ? runConfig(assignee, folders) : null;
        if (cfg) {
            const started = await createRunTx(tx, issue, { trigger: 'assign', ...cfg, supersede: false });
            issue = started.issue;
            runs.push(runView(started.run));
        }
        return { issue: issueView(issue), runs };
    });
}

type HumanPatch = Omit<IssueUpdate, 'ifVersion'>;

/**
 * Human field change (any status). Writes one timeline entry per kind
 * (status / assign / field — field names only), clears `statusRunId` on a
 * status change, closes the attention items the move settles, and starts /
 * supersedes runs per §3.1. `owner` = the board's「完成」/「退回」.
 */
async function applyHumanUpdateTx(tx: Tx, accountId: string, issue: IssueRow, patch: HumanPatch, opts: { owner?: { choice: string; note: string | null }; noRun?: boolean } = {}): Promise<{ issue: IssueRow; runs: RunRow[] }> {
    const projectId = patch.projectId !== undefined ? patch.projectId : issue.projectId;
    const folders = await projectFolders(tx, accountId, projectId);
    const beforeAssignee = readAssignee(issue.assignee);
    const assignee = patch.assignee ? await validateAssignee(tx, accountId, patch.assignee, folders) : beforeAssignee;
    if (patch.parentId) await checkParent(tx, accountId, issue.id, patch.parentId);
    const status = patch.status ?? issue.status;
    const statusChanged = status !== issue.status;
    const assigneeChanged = patch.assignee !== undefined && canonicalJson(beforeAssignee) !== canonicalJson(assignee);
    const fields = changedFieldNames(issue, patch as Record<string, unknown>);
    if (patch.sortOrder !== undefined && patch.sortOrder !== issue.sortOrder) fields.push('sortOrder');
    if (!statusChanged && !assigneeChanged && fields.length === 0) return { issue, runs: [] };
    const now = new Date();
    let updated = await updateIssue(tx, issue.id, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.projectId !== undefined ? { project: patch.projectId ? { connect: { id: patch.projectId } } : { disconnect: true } } : {}),
        ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt ? new Date(patch.dueAt) : null } : {}),
        ...(patch.parentId !== undefined ? { parent: patch.parentId ? { connect: { id: patch.parentId } } : { disconnect: true } } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(assigneeChanged ? { assigneeKind: assignee.kind, assignee: json(assignee) } : {}),
        ...(statusChanged ? {
            status, statusRunId: null, statusChangedAt: now,
            completedAt: isIssueClosed(status) ? now : null,
        } : {}),
    });
    if (statusChanged) await addTimeline(tx, issue, { ...statusEntry(issue.status, status), authorKind: 'user' });
    if (assigneeChanged) await addTimeline(tx, issue, { kind: 'assign', authorKind: 'user', body: `${beforeAssignee.kind} → ${assignee.kind}`, data: { from: beforeAssignee, to: assignee } });
    const plainFields = fields.filter(f => f !== 'sortOrder');
    if (plainFields.length) await addTimeline(tx, issue, { kind: 'field', authorKind: 'user', body: plainFields.join(', '), data: { fields: plainFields } });
    if (statusChanged) await closeForStatusTx(tx, accountId, issue.id, issue.status, status, false, opts.owner);
    const runs: RunRow[] = [];
    if (opts.noRun) return { issue: updated, runs };
    const plan = planHumanUpdateRun({ before: { status: issue.status, assignee: beforeAssignee }, after: { status, assignee }, hasActiveRun: (await activeRuns(tx, issue.id)).length > 0 });
    const cfg = plan.start ? runConfig(assignee, folders) : null;
    if (plan.start && cfg) {
        const started = await createRunTx(tx, updated, { trigger: 'assign', ...cfg, supersede: plan.supersede });
        updated = started.issue;
        runs.push(started.run);
    }
    return { issue: updated, runs };
}

/** Attention + owner-mention / failure acknowledgements a status move settles. */
async function closeForStatusTx(tx: Tx, accountId: string, issueId: string, from: string, to: string, deleted: boolean, owner?: { choice: string; note: string | null }) {
    const closing = deleted || isIssueClosed(to);
    let runIds: string[] = [];
    let mentionCommentIds: string[] = [];
    if (closing) {
        const now = new Date();
        const failed = await tx.issueRun.findMany({ where: { issueId, status: 'failed', failureAckedAt: null } });
        for (const f of failed) emitRun(tx, await tx.issueRun.update({ where: { id: f.id }, data: { failureAckedAt: now } }));
        runIds = (await tx.issueRun.findMany({ where: { issueId }, select: { id: true } })).map(r => r.id);
        mentionCommentIds = await ackOwnerMentionsTx(tx, issueId, now);
    }
    await bridgeStatusLeft(tx, accountId, { issueId, from, to, deleted, runIds, mentionCommentIds, owner });
}

/** Marks the issue's open @我 mentions handled; returns their comment ids. */
async function ackOwnerMentionsTx(tx: Tx, issueId: string, now: Date): Promise<string[]> {
    const open = await tx.issueComment.findMany({ where: { issueId, ownerAckedAt: null, authorKind: 'agent', mentions: { array_contains: [{ kind: 'owner' }] } } });
    for (const c of open) emitComment(tx, await tx.issueComment.update({ where: { id: c.id }, data: { ownerAckedAt: now } }));
    return open.map(c => c.id);
}

export async function updateIssueFields(accountId: string, ref: string, input: IssueUpdate): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const issue = await loadIssue(tx, accountId, ref);
        if (input.ifVersion !== undefined && input.ifVersion !== issue.version) throw new IssueError('issue_version_conflict', 409, { issue: issueView(issue) });
        const { ifVersion: _ifVersion, ...patch } = input;
        const out = await applyHumanUpdateTx(tx, accountId, issue, patch);
        return { issue: issueView(out.issue), runs: out.runs.map(runView) };
    });
}

/** Soft delete: tombstone (still served by `updatedSince`), active runs cancelled, open items dismissed. Idempotent. */
export async function deleteIssue(accountId: string, ref: string): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const issue = await loadIssue(tx, accountId, ref, { allowDeleted: true });
        if (issue.deletedAt) return { issue: issueView(issue) };
        for (const run of await activeRuns(tx, issue.id)) await endRun(tx, run, 'cancelled');
        const updated = await updateIssue(tx, issue.id, { deletedAt: new Date() });
        await closeForStatusTx(tx, accountId, issue.id, issue.status, issue.status, true);
        return { issue: issueView(updated) };
    });
}

/**
 * Board「完成」/「退回」on a 待验收 item (called by the attention store before
 * it closes the item). done → issue done; return → issue todo and the owner's
 * note becomes a human comment, routed back to the agent (§6, §7).
 */
export async function settleIssueReview(accountId: string, issueId: string, choice: string, note?: string): Promise<void> {
    const { AttentionError } = await import('@/app/attention/rules');
    if (choice !== ISSUE_REVIEW_CHOICES.done && choice !== ISSUE_REVIEW_CHOICES.return) throw new AttentionError('attention_unknown_choice', 400);
    if (!issuesEnabled()) throw new AttentionError('attention_item_stale', 409);
    await runIssueTx(async tx => {
        const issue = await tx.issue.findFirst({ where: { id: issueId, accountId, deletedAt: null } });
        if (!issue || issue.status !== 'in_review') throw new AttentionError('attention_item_stale', 409);
        const owner = { choice, note: note?.trim() || null };
        const out = await applyHumanUpdateTx(tx, accountId, issue, { status: choice === ISSUE_REVIEW_CHOICES.done ? 'done' : 'todo' }, { owner });
        if (choice === ISSUE_REVIEW_CHOICES.return) {
            await createHumanCommentTx(tx, accountId, out.issue, { body: owner.note ?? 'Returned from review: please continue.' });
        }
    });
}

// ─── Human: comments ─────────────────────────────────────────────────────────

/**
 * Stores a human comment, handles the issue's open @我 mentions, then routes
 * it (§6): each target joins a live run of the same agent (queued message),
 * is absorbed by a run whose session has not started, or starts a new run.
 */
async function createHumanCommentTx(tx: Tx, accountId: string, issue: IssueRow, input: IssueCommentCreate): Promise<{ comment: CommentRow; runs: RunRow[] }> {
    const mentions: IssueMention[] = input.mentions ?? [];
    const assignee = readAssignee(issue.assignee);
    const folders = await projectFolders(tx, accountId, issue.projectId);
    const route = routeIssueComment({ authorKind: 'user', body: input.body, mentions, status: issue.status, assignee });
    const targets = route.kind === 'route' ? route.targets.map(t => ({ ...t, machineId: t.machineId ?? defaultMentionMachine(assignee, folders) })) : [];
    for (const t of targets) {
        requireIssue(t.machineId, 'issue_machine_not_found', 400, { agent: t.agent });
        await requireMachine(tx, accountId, t.machineId);
    }
    const now = new Date();
    let comment = await addTimeline(tx, issue, {
        kind: 'comment', authorKind: 'user', body: input.body, mentions, refSessionId: input.refSessionId ?? null,
        requestKey: requestKey('comment', accountId, input.requestId),
    });
    const handled = await ackOwnerMentionsTx(tx, issue.id, now);
    await bridgeOwnerMentionsHandled(tx, accountId, handled);

    const runs: RunRow[] = [];
    const routed: string[] = [];
    let current = issue;
    for (const target of targets) {
        const machineId = target.machineId!;
        const active = await activeRuns(tx, issue.id);
        const live = await liveSessions(tx, accountId, active.map(r => r.sessionId).filter((s): s is string => !!s));
        const choice = chooseIssueDelivery({ ...target, machineId }, active.map(runView), sid => live.has(sid));
        if (choice.mode === 'message') {
            const run = active.find(r => r.id === choice.runId)!;
            const payload: MessagePayload = {
                sessionId: run.sessionId!, commentId: comment.id, trigger: target.viaMention ? 'mention' : 'comment',
                text: buildIssueCommentPrompt({ issue: issueView(current), comment: commentView(comment) }),
            };
            await tx.issueDispatch.create({ data: { id: randomUUID(), accountId, runId: run.id, issueId: issue.id, machineId: run.machineId, kind: 'message', payload: json(payload), status: 'queued' } });
            routed.push(run.id);
            continue;
        }
        if (choice.mode === 'absorbed') { routed.push(choice.runId); continue; }
        // No live session for this agent: a run of it whose session died is over.
        for (const run of active) {
            if (run.agent === target.agent && run.machineId === machineId && run.sessionId && !live.has(run.sessionId) && (run.status === 'running' || run.status === 'idle')) await endRun(tx, run, 'ended');
        }
        const assigned = agentAssigneeOf(assignee);
        const config: AgentAssignee = assigned && assigned.agent === target.agent && assigned.machineId === machineId
            ? assignee as AgentAssignee
            : { kind: 'agent', agent: target.agent, machineId };
        // Another agent on the assignee's machine works where the assignee works (unless the project names a folder there).
        const fallback = assigned && assigned.machineId === machineId ? (assignee as AgentAssignee).directory : undefined;
        const directory = resolveRunDirectory(config.directory, folders, machineId) ?? fallback ?? null;
        requireIssue(directory, 'issue_no_directory', 400, { machineId });
        const started = await createRunTx(tx, current, { trigger: target.viaMention ? 'mention' : 'comment', triggerCommentId: comment.id, config, directory, supersede: false });
        current = started.issue;
        runs.push(started.run);
        routed.push(started.run.id);
    }
    if (routed.length) {
        comment = await tx.issueComment.update({ where: { id: comment.id }, data: { routedRunIds: routed } });
        emitComment(tx, comment);
    }
    return { comment, runs };
}

export async function createComment(accountId: string, ref: string, input: IssueCommentCreate): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const issue = await loadIssue(tx, accountId, ref);
        const key = requestKey('comment', accountId, input.requestId);
        if (key) {
            const prior = await tx.issueComment.findFirst({ where: { requestKey: key, accountId } });
            if (prior) return { issue: issueView(issue), comment: commentView(prior) };
        }
        const out = await createHumanCommentTx(tx, accountId, issue, input);
        const latest = await tx.issue.findUniqueOrThrow({ where: { id: issue.id } });
        return { issue: issueView(latest), comment: commentView(out.comment), runs: out.runs.map(runView) };
    });
}

async function loadOwnComment(tx: Tx, accountId: string, issueId: string, commentId: string): Promise<CommentRow> {
    const row = await tx.issueComment.findFirst({ where: { id: commentId, issueId, accountId, deletedAt: null } });
    requireIssue(row, 'issue_comment_not_found', 404);
    // Only the person's own prose: agent comments and system entries are history.
    requireIssue(row.kind === 'comment' && row.authorKind === 'user', 'issue_comment_not_editable', 409);
    return row;
}

export async function editComment(accountId: string, ref: string, commentId: string, body: string): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const issue = await loadIssue(tx, accountId, ref);
        await loadOwnComment(tx, accountId, issue.id, commentId);
        const row = await tx.issueComment.update({ where: { id: commentId }, data: { body, editedAt: new Date() } });
        emitComment(tx, row);
        return { issue: issueView(issue), comment: commentView(row) };
    });
}

export async function deleteComment(accountId: string, ref: string, commentId: string): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const issue = await loadIssue(tx, accountId, ref);
        await loadOwnComment(tx, accountId, issue.id, commentId);
        const row = await tx.issueComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
        emitComment(tx, row);
        return { issue: issueView(issue), comment: commentView(row) };
    });
}

// ─── Human: runs ─────────────────────────────────────────────────────────────

/** POST /v1/issues/:id/runs: retry / run with another agent. Always a new run; older active runs are superseded. */
export async function createRun(accountId: string, ref: string, input: IssueRunCreate): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        let issue = await loadIssue(tx, accountId, ref);
        const key = requestKey('run', accountId, input.requestId);
        if (key) {
            const prior = await tx.issueRun.findFirst({ where: { requestKey: key, accountId } });
            if (prior) return { issue: issueView(issue), runs: [runView(prior)] };
        }
        const folders = await projectFolders(tx, accountId, issue.projectId);
        const assignee = input.assignee ? await validateAssignee(tx, accountId, input.assignee, folders) : readAssignee(issue.assignee);
        requireIssue(agentAssigneeOf(assignee), 'issue_assignee_unsupported', 400);
        // 换 agent: the assignee changes here; the retry run below is the only run started (§3.1 auto-start skipped).
        if (input.reassign && input.assignee) issue = (await applyHumanUpdateTx(tx, accountId, issue, { assignee: assignee as IssueUpdate['assignee'] }, { noRun: true })).issue;
        const cfg = runConfig(assignee, folders);
        requireIssue(cfg, 'issue_no_directory', 400);
        const started = await createRunTx(tx, issue, { trigger: 'retry', ...cfg, supersede: true, requestKey: key });
        return { issue: issueView(started.issue), runs: [runView(started.run)] };
    });
}

async function loadRun(tx: Tx, accountId: string, runId: string): Promise<RunRow> {
    const run = await tx.issueRun.findFirst({ where: { id: runId, accountId } });
    requireIssue(run, 'issue_run_not_found', 404);
    return run;
}

/** Stops a run (human). The session itself is left alone (phase 1: stop it from the session page). Idempotent. */
export async function cancelRun(accountId: string, runId: string): Promise<{ run: IssueRunView }> {
    return runIssueTx(async tx => {
        const run = await loadRun(tx, accountId, runId);
        if (!isIssueRunActive(run.status)) return { run: runView(run) };
        return { run: runView(await endRun(tx, run, 'cancelled')) };
    });
}

/** 「知道了」on a failed run: it leaves 「需要我决策」 without a retry. Idempotent. */
export async function ackRunFailure(accountId: string, runId: string): Promise<{ run: IssueRunView }> {
    return runIssueTx(async tx => {
        const run = await loadRun(tx, accountId, runId);
        requireIssue(run.status === 'failed', 'issue_run_not_failed', 409);
        if (run.failureAckedAt) return { run: runView(run) };
        const updated = await tx.issueRun.update({ where: { id: run.id }, data: { failureAckedAt: new Date() } });
        emitRun(tx, updated);
        await bridgeRunFailuresCleared(tx, accountId, [run.id], 'owner');
        return { run: runView(updated) };
    });
}

// ─── Agent (wrapper-stamped sessionId) ───────────────────────────────────────

async function boundRun(tx: Tx, accountId: string, sessionId: string): Promise<{ run: RunRow; issue: IssueRow }> {
    const run = await tx.issueRun.findFirst({ where: { sessionId, accountId } });
    requireIssue(run, 'issue_not_bound', 409);
    const issue = await tx.issue.findFirst({ where: { id: run.issueId, accountId } });
    requireIssue(issue && !issue.deletedAt, 'issue_not_found', 404);
    requireIssue(isIssueRunActive(run.status), 'issue_run_not_current', 409, { message: 'This issue has moved to a newer run; stop changing it.' });
    return { run, issue };
}

async function enforceAgentCommentQuota(tx: Tx, runId: string) {
    const recent = await tx.issueComment.count({ where: { authorRunId: runId, authorKind: 'agent', kind: 'comment', createdAt: { gt: new Date(Date.now() - 3600_000) } } });
    requireIssue(recent < ISSUE_LIMITS.agentCommentsPerRunHour, 'issue_comment_quota_exceeded', 429, { limit: ISSUE_LIMITS.agentCommentsPerRunHour });
}

async function agentCommentTx(tx: Tx, run: RunRow, issue: IssueRow, body: string, mentionOwner: boolean, key: string | null): Promise<CommentRow> {
    await enforceAgentCommentQuota(tx, run.id);
    const comment = await addTimeline(tx, issue, {
        kind: 'comment', authorKind: 'agent', authorSessionId: run.sessionId, authorRunId: run.id, body,
        mentions: mentionOwner ? [{ kind: 'owner' }] : [], requestKey: key,
    });
    if (mentionOwner && run.sessionId) await bridgeOwnerMention(tx, issue.accountId, issueView(issue), run.sessionId, comment);
    return comment;
}

/**
 * `issue_update`: status (agent subset, `checkAgentStatusChange` enforced
 * here — done / cancelled never, closed issues never, in_review / blocked
 * need a comment) and / or a comment, on the session's bound issue only.
 */
export async function agentUpdate(accountId: string, input: Omit<IssueAgentUpdate, 'status'> & { status?: string }): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const { run, issue } = await boundRun(tx, accountId, input.sessionId);
        const key = requestKey('agent', accountId, input.requestId);
        if (key) {
            const prior = await tx.issueComment.findFirst({ where: { requestKey: key, accountId } });
            if (prior) return { issue: issueView(issue), comment: commentView(prior) };
        }
        if (input.status !== undefined) {
            const check = checkAgentStatusChange(issue.status, input.status, input.comment);
            if (!check.ok) throw new IssueError(check.code, check.code === 'issue_comment_required' ? 400 : 409);
        }
        const comment = input.comment !== undefined ? await agentCommentTx(tx, run, issue, input.comment, false, key) : null;
        let updated = issue;
        if (input.status !== undefined && input.status !== issue.status) {
            const now = new Date();
            updated = await updateIssue(tx, issue.id, { status: input.status, statusRunId: run.id, statusChangedAt: now, ...(issue.startedAt ? {} : { startedAt: now }) });
            await addTimeline(tx, issue, { ...statusEntry(issue.status, input.status), authorKind: 'agent', authorSessionId: run.sessionId, authorRunId: run.id });
            await closeForStatusTx(tx, accountId, issue.id, issue.status, input.status, false);
            if (run.sessionId) await bridgeAgentStatus(tx, accountId, issueView(updated), run.sessionId, input.status, comment);
        }
        return { issue: issueView(updated), ...(comment ? { comment: commentView(comment) } : {}) };
    });
}

/** `issue_comment` (`mention_owner` → @我). Agent comments never wake anyone (§6 loop guard). */
export async function agentComment(accountId: string, input: IssueAgentComment): Promise<IssueMutationResponse> {
    return runIssueTx(async tx => {
        const { run, issue } = await boundRun(tx, accountId, input.sessionId);
        const key = requestKey('agent', accountId, input.requestId);
        if (key) {
            const prior = await tx.issueComment.findFirst({ where: { requestKey: key, accountId } });
            if (prior) return { issue: issueView(issue), comment: commentView(prior) };
        }
        const comment = await agentCommentTx(tx, run, issue, input.body, input.mentionOwner === true, key);
        return { issue: issueView(issue), comment: commentView(comment) };
    });
}

/**
 * What a wrapper needs (§4/§5): the bound issue, its run, whether writes are
 * allowed, and timeline entries — the latest few, or those after `since`
 * (next-turn digest). Not bound → `issue: null`.
 */
export async function sessionIssueContext(accountId: string, sessionId: string, since?: number): Promise<IssueSessionContext> {
    return runIssueTx(async tx => {
        const asOf = Date.now();
        const run = await tx.issueRun.findFirst({ where: { sessionId, accountId } });
        const issue = run ? await tx.issue.findFirst({ where: { id: run.issueId, accountId, deletedAt: null } }) : null;
        if (!run || !issue) return { issue: null, run: null, current: false, comments: [], asOf };
        const comments = since !== undefined
            ? await tx.issueComment.findMany({ where: { issueId: issue.id, deletedAt: null, createdAt: { gt: new Date(since) } }, orderBy: { createdAt: 'asc' }, take: 50 })
            : (await tx.issueComment.findMany({ where: { issueId: issue.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: ISSUE_LIMITS.contextComments })).reverse();
        return { issue: issueView(issue), run: runView(run), current: isIssueRunActive(run.status), comments: comments.map(commentView), asOf };
    });
}

export { IssueError };
