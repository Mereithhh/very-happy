import { z } from 'zod';
import { AgentProfileChoiceSchema, type AgentProfileRef } from './agentProfiles';
import type { BuiltinTodo } from './builtinTodos';

// B-871 Issues, phase 1 (`specs/2026-11-issues.md`). An Issue is a long-lived,
// human-owned work item; a run is one execution of it in a session (one issue,
// many runs). Stored server-side in plaintext, same trust tier as Projects /
// Teams / Todos / AttentionItem (spec §2.6). Single account only.
//
// Request schemas are strict (the server validates them). Views are plain TS
// types and every enum-like view field is an open string, so a client
// tolerates values a newer server adds (AGENTS #4/#14): read them through the
// `ISSUE_*` lists and helpers below.

/** Wrapper advertises this in `metadata.capabilities` once it registers `issue_*` tools and reads the issue binding. */
export const ISSUE_SESSION_CAPABILITY = 'issue-v1';
/** Error code every `/v1/issues*` route returns (HTTP 404) while `VH_ISSUES_ENABLED` is off; same shape as an old server's unknown route. */
export const ISSUES_DISABLED_ERROR = 'issues_disabled';
/** Daemon issue-worker protocol version, sent on every dispatch poll. The server only hands dispatches to workers it knows. */
export const ISSUE_WORKER_VERSION = 1;
/** Display prefix of the account-scoped number (`VH-12`). Fixed in phase 1. */
export const ISSUE_KEY_PREFIX = 'VH';
/**
 * localId prefix of every user message the daemon delivers for an issue
 * (`issue-<dispatchId>`). The server's owner-authored-message rule
 * (`isOwnerAuthoredMessage`) must treat it like `automation-` / `teams-`:
 * an issue dispatch is not the owner talking in the session.
 */
export const ISSUE_DISPATCH_LOCAL_ID_PREFIX = 'issue-';
/** `sentFrom` the daemon stamps on issue dispatch messages. */
export const ISSUE_SENT_FROM = 'issue';
/** A human comment starting with this is a note: stored, shown, never routed to an agent. */
export const ISSUE_NOTE_PREFIX = '/note';

export const ISSUE_LIMITS = {
    titleChars: 300,
    descriptionBytes: 32 * 1024,
    commentBytes: 16 * 1024,
    labels: 16,
    labelChars: 40,
    /** Distinct agents one comment may @ (each becomes a delivery or a run). */
    mentionsPerComment: 3,
    /** Recent comments the initial prompt and `issue_get` include. */
    contextComments: 10,
    issuesPerAccount: 10_000,
    listMax: 500,
    /** Parent chain depth the server walks when checking for cycles. */
    parentDepth: 10,
    /** Agent-authored comments per run per hour (loop guard). */
    agentCommentsPerRunHour: 30,
} as const;

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];
export const ISSUE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type IssuePriority = typeof ISSUE_PRIORITIES[number];
/** The only statuses an agent may set (server-enforced). `done` / `cancelled` are human-only. */
export const ISSUE_AGENT_STATUSES = ['in_progress', 'in_review', 'blocked'] as const;
export type IssueAgentStatus = typeof ISSUE_AGENT_STATUSES[number];
/** Statuses where an agent assignee is expected to be working (comments without @ route to it; assignment starts a run). */
export const ISSUE_RUNNABLE_STATUSES: readonly IssueStatus[] = ['todo', 'in_progress', 'in_review', 'blocked'];
export const ISSUE_CLOSED_STATUSES: readonly IssueStatus[] = ['done', 'cancelled'];

/** Agents an issue may be assigned to in phase 1: the runners whose happy MCP tools and prompt injection are verified. */
export const ISSUE_ASSIGNABLE_AGENTS = ['claude', 'codex', 'pi'] as const;
export type IssueAssignableAgent = typeof ISSUE_ASSIGNABLE_AGENTS[number];

/** `team` is reserved for phase 3 (routed by a team lead); a phase-1 server answers `issue_assignee_unsupported`. */
export const ISSUE_ASSIGNEE_KINDS = ['none', 'self', 'agent', 'team'] as const;
export type IssueAssigneeKind = typeof ISSUE_ASSIGNEE_KINDS[number];

/** Why a run started. */
export const ISSUE_RUN_TRIGGERS = ['assign', 'mention', 'comment', 'retry'] as const;
export type IssueRunTrigger = typeof ISSUE_RUN_TRIGGERS[number];
/**
 * Run lifecycle (the session, not the issue):
 * queued → claimed (a daemon took the dispatch) → running (session spawned, turn live) ⇄ idle (turn ended, session alive)
 * → ended (session exited / archived) | failed (spawn failed, wrapper crashed, account refused) | cancelled (human)
 * | superseded (reassign / retry started a newer run; the old session stays but may no longer write).
 */
export const ISSUE_RUN_STATUSES = ['queued', 'claimed', 'running', 'idle', 'ended', 'failed', 'cancelled', 'superseded'] as const;
export type IssueRunStatus = typeof ISSUE_RUN_STATUSES[number];
/** A run in one of these may receive comment deliveries and agent writes. */
export const ISSUE_RUN_ACTIVE_STATUSES: readonly IssueRunStatus[] = ['queued', 'claimed', 'running', 'idle'];

/** Timeline entries: `comment` is prose; the rest are system entries the server writes on changes. */
export const ISSUE_COMMENT_KINDS = ['comment', 'status', 'assign', 'run', 'field'] as const;
export type IssueCommentKind = typeof ISSUE_COMMENT_KINDS[number];
export const ISSUE_ACTOR_KINDS = ['user', 'agent', 'system', 'import'] as const;
export type IssueActorKind = typeof ISSUE_ACTOR_KINDS[number];

/** Daemon work items: start a run's session, or deliver a message into a run's live session. */
export const ISSUE_DISPATCH_KINDS = ['spawn', 'message'] as const;
export type IssueDispatchKind = typeof ISSUE_DISPATCH_KINDS[number];
export const ISSUE_DISPATCH_STATUSES = ['queued', 'claimed', 'done', 'failed', 'cancelled'] as const;

export function isIssueStatus(value: unknown): value is IssueStatus {
    return typeof value === 'string' && (ISSUE_STATUSES as readonly string[]).includes(value);
}
export function isIssueClosed(status: string): boolean {
    return (ISSUE_CLOSED_STATUSES as readonly string[]).includes(status);
}
export function isIssueRunActive(status: string): boolean {
    return (ISSUE_RUN_ACTIVE_STATUSES as readonly string[]).includes(status);
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

export function formatIssueKey(number: number): string {
    return `${ISSUE_KEY_PREFIX}-${number}`;
}

const ISSUE_KEY_PATTERN = new RegExp(`^${ISSUE_KEY_PREFIX}-(\\d{1,9})$`, 'i');
const UUIDISH = /^[A-Za-z0-9_-]{8,128}$/;
/** `VH-12`, `12`, `#12` → number; an id-looking token → id; anything else → null. Shared by the CLI and ⌘K. */
export function parseIssueRef(input: string): { number: number } | { id: string } | null {
    const value = input.trim();
    const key = ISSUE_KEY_PATTERN.exec(value) ?? /^#?(\d{1,9})$/.exec(value);
    if (key) {
        const n = Number(key[1]);
        return n > 0 ? { number: n } : null;
    }
    return UUIDISH.test(value) ? { id: value } : null;
}

// ─── Rules (pure; the server enforces, the CLI and Web pre-check) ─────────────

export type IssueAgentStatusCheck =
    | { ok: true }
    | { ok: false; code: 'issue_status_forbidden' | 'issue_closed' | 'issue_comment_required' };

/**
 * An agent may move an open issue to in_progress / in_review / blocked only;
 * a closed issue (done / cancelled) is never changed by an agent; in_review and
 * blocked need a comment saying what was delivered / what is missing.
 */
export function checkAgentStatusChange(from: string, to: string, comment: string | null | undefined): IssueAgentStatusCheck {
    if (!(ISSUE_AGENT_STATUSES as readonly string[]).includes(to)) return { ok: false, code: 'issue_status_forbidden' };
    if (isIssueClosed(from)) return { ok: false, code: 'issue_closed' };
    if ((to === 'in_review' || to === 'blocked') && !comment?.trim()) return { ok: false, code: 'issue_comment_required' };
    return { ok: true };
}

/** Assignment / status change starts a run only for an agent assignee on a runnable status (backlog only records ownership). */
export function issueShouldRun(status: string, assignee: IssueAssigneeView): boolean {
    return agentAssigneeOf(assignee) !== null && (ISSUE_RUNNABLE_STATUSES as readonly string[]).includes(status);
}

/** Recommended (spec §3.4): a run reaching `running` moves `todo` to `in_progress` for the agent; every other status is left alone. */
export function issueStatusOnRunStart(status: string): string {
    return status === 'todo' ? 'in_progress' : status;
}

/**
 * A run failed: an issue still `in_progress` because of this run (it set it,
 * or the run start did) goes back to `todo`; anything the agent or the human
 * moved since stays.
 */
export function issueStatusAfterRunFailure(issue: { status: string; statusRunId: string | null }, runId: string): string {
    return issue.status === 'in_progress' && issue.statusRunId === runId ? 'todo' : issue.status;
}

/** The agent assignee's machine + agent, or null for any other (or unknown) kind. */
export function agentAssigneeOf(assignee: IssueAssigneeView): { machineId: string; agent: string } | null {
    if (assignee.kind !== 'agent') return null;
    const { machineId, agent } = assignee as { machineId?: unknown; agent?: unknown };
    return typeof machineId === 'string' && typeof agent === 'string' ? { machineId, agent } : null;
}

export type IssueCommentTarget = { agent: string; machineId: string | null; viaMention: boolean };
export type IssueCommentRoute =
    | { kind: 'route'; targets: IssueCommentTarget[] }
    | { kind: 'none'; reason: 'not-human' | 'note' | 'no-agent-assignee' | 'inactive-status' };

/**
 * Who a new comment wakes. Only human comments route (an agent's own comments
 * never wake anyone, Multica-style loop guard). `/note` never routes. An @
 * routes to each mentioned agent whatever the status; without an @ it goes to
 * the issue's agent assignee while the issue is runnable.
 */
export function routeIssueComment(input: {
    authorKind: string;
    body: string;
    mentions: readonly IssueMention[];
    status: string;
    assignee: IssueAssigneeView;
}): IssueCommentRoute {
    if (input.authorKind !== 'user') return { kind: 'none', reason: 'not-human' };
    const body = input.body.trimStart();
    if (body === ISSUE_NOTE_PREFIX || body.startsWith(`${ISSUE_NOTE_PREFIX} `) || body.startsWith(`${ISSUE_NOTE_PREFIX}\n`)) return { kind: 'none', reason: 'note' };
    const assigned = agentAssigneeOf(input.assignee);
    const seen = new Set<string>();
    const targets: IssueCommentTarget[] = [];
    for (const m of input.mentions) {
        if (m.kind !== 'agent') continue;
        const machineId = m.machineId ?? (assigned && assigned.agent === m.agent ? assigned.machineId : null);
        const key = `${m.agent}@${machineId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ agent: m.agent, machineId, viaMention: true });
    }
    if (targets.length) return { kind: 'route', targets: targets.slice(0, ISSUE_LIMITS.mentionsPerComment) };
    if (!assigned) return { kind: 'none', reason: 'no-agent-assignee' };
    if (!(ISSUE_RUNNABLE_STATUSES as readonly string[]).includes(input.status)) return { kind: 'none', reason: 'inactive-status' };
    return { kind: 'route', targets: [{ agent: assigned.agent, machineId: assigned.machineId, viaMention: false }] };
}

/**
 * Merge or spawn (spec §3.5): a target joins the newest active run of the same
 * agent on the same machine whose session is live (delivered as a queued
 * message, never steer/interrupt); otherwise a new run starts. A run still
 * queued/claimed (no session yet) absorbs the comment without a dispatch: the
 * initial prompt reads the latest comments when it is built.
 */
export function chooseIssueDelivery(
    target: IssueCommentTarget,
    runs: readonly Pick<IssueRunView, 'id' | 'status' | 'agent' | 'machineId' | 'sessionId' | 'createdAt'>[],
    liveSession: (sessionId: string) => boolean,
): { mode: 'message'; runId: string } | { mode: 'absorbed'; runId: string } | { mode: 'spawn' } {
    const candidates = runs
        .filter(r => isIssueRunActive(r.status) && r.agent === target.agent && (target.machineId === null || r.machineId === target.machineId))
        .sort((a, b) => b.createdAt - a.createdAt);
    for (const run of candidates) {
        if (run.status === 'queued' || run.status === 'claimed') return { mode: 'absorbed', runId: run.id };
        if (run.sessionId && liveSession(run.sessionId)) return { mode: 'message', runId: run.id };
    }
    return { mode: 'spawn' };
}

// ─── Shared schema pieces ─────────────────────────────────────────────────────

const id = z.string().min(1).max(128);
const requestId = z.string().min(1).max(128);
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const boundedText = (maxBytes: number) => z.string().max(maxBytes).refine(v => utf8Bytes(v) <= maxBytes, `exceeds ${maxBytes} bytes`);
const title = z.string().trim().min(1).max(ISSUE_LIMITS.titleChars);
const description = boundedText(ISSUE_LIMITS.descriptionBytes);
const commentBody = boundedText(ISSUE_LIMITS.commentBytes).pipe(z.string().trim().min(1));
const label = z.string().trim().min(1).max(ISSUE_LIMITS.labelChars);
const labels = z.array(label).max(ISSUE_LIMITS.labels);
const epochMs = z.number().int().min(0).max(8640000000000000);

/**
 * "Agent 指派": which machine runs which agent, on which account, with which
 * model / mode. `directory` absent = the project's folder on that machine
 * (primary first); the server refuses `issue_no_directory` when neither exists.
 * `agentProfile` follows B-850d: absent = project / machine default, null = machine login.
 */
export const IssueAgentAssigneeSchema = z.object({
    kind: z.literal('agent'),
    machineId: id,
    agent: z.enum(ISSUE_ASSIGNABLE_AGENTS),
    agentProfile: AgentProfileChoiceSchema.optional(),
    model: z.string().trim().min(1).max(256).nullable().optional(),
    permissionMode: z.string().trim().min(1).max(64).nullable().optional(),
    directory: z.string().min(1).max(4096).optional(),
    /** Reserved: run each issue in its own worktree (team-style). Phase 1 servers store it; the daemon ignores it until spec §3.6 lands. */
    worktree: z.boolean().optional(),
});
export const IssueAssigneeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('self') }),
    IssueAgentAssigneeSchema,
    /** Phase 3; accepted by the schema so the contract is stable, refused by a phase-1 server. */
    z.object({ kind: z.literal('team'), teamId: id }),
]);
export type IssueAssignee = z.infer<typeof IssueAssigneeSchema>;

/** `@` in a human comment. Web/CLI send it structured; the server never parses `@` out of prose. */
export const IssueMentionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), agent: z.enum(ISSUE_ASSIGNABLE_AGENTS), machineId: id.optional() }),
    /** Written by the server from an agent's `issue_comment({ mention_owner: true })`; a client may not send it. */
    z.object({ kind: z.literal('owner') }),
]);
export type IssueMention = z.infer<typeof IssueMentionSchema>;
const humanMentions = z.array(IssueMentionSchema).max(ISSUE_LIMITS.mentionsPerComment)
    .refine(list => list.every(m => m.kind === 'agent'), 'only agent mentions may be sent');

// ─── REST requests (human / Web / CLI outside a session) ──────────────────────

/** POST /v1/issues → `IssueMutationResponse`. Agent assignee + runnable status starts a run in the same transaction. */
export const IssueCreateSchema = z.object({
    title,
    description: description.optional(),
    /** Default: `todo` when assigned to an agent, otherwise `backlog`. */
    status: z.enum(ISSUE_STATUSES).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    assignee: IssueAssigneeSchema.optional(),
    projectId: id.nullable().optional(),
    labels: labels.optional(),
    dueAt: epochMs.nullable().optional(),
    parentId: id.nullable().optional(),
    /** Idempotency: the same requestId returns the issue it created. */
    requestId: requestId.optional(),
});
export type IssueCreate = z.infer<typeof IssueCreateSchema>;

/**
 * PATCH /v1/issues/:id (human). Any status is allowed. `ifVersion` makes the
 * write a CAS (409 `issue_version_conflict` + latest issue); the Web sends it
 * for description edits, field chips may omit it.
 */
export const IssueUpdateSchema = z.object({
    title: title.optional(),
    description: description.optional(),
    status: z.enum(ISSUE_STATUSES).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    assignee: IssueAssigneeSchema.optional(),
    projectId: id.nullable().optional(),
    labels: labels.optional(),
    dueAt: epochMs.nullable().optional(),
    parentId: id.nullable().optional(),
    /** Fractional board order within a status column. */
    sortOrder: z.number().finite().optional(),
    ifVersion: z.number().int().min(1).optional(),
});
export type IssueUpdate = z.infer<typeof IssueUpdateSchema>;

/** POST /v1/issues/:id/comments (human). */
export const IssueCommentCreateSchema = z.object({
    body: commentBody,
    mentions: humanMentions.optional(),
    /** A session this comment quotes / refers to (shown as a chip). */
    refSessionId: id.optional(),
    requestId: requestId.optional(),
});
export type IssueCommentCreate = z.infer<typeof IssueCommentCreateSchema>;

/** POST /v1/issues/:id/runs — retry or "run with another agent". Absent `assignee` = the issue's current agent assignee. Always a new run; older active runs become `superseded`. */
export const IssueRunCreateSchema = z.object({
    assignee: IssueAgentAssigneeSchema.optional(),
    /** Also make it the issue's assignee (換 agent). */
    reassign: z.boolean().optional(),
    requestId: requestId.optional(),
});
export type IssueRunCreate = z.infer<typeof IssueRunCreateSchema>;

/** POST /v1/issues/runs/:runId/cancel (human): stops a queued run, or marks a live one cancelled and asks its daemon to archive the session. */
export const IssueRunCancelSchema = z.object({ archiveSession: z.boolean().optional() });

/** POST /v1/issues/runs/:runId/ack-failure (human): clears a failed run from 「需要我决策」 without retrying. */
export const IssueRunAckSchema = z.object({});

/** GET /v1/issues query. `updatedSince` (epoch ms, from the previous response's `asOf`) returns changed issues including tombstones. */
export const IssueListQuerySchema = z.object({
    status: z.string().max(200).optional(),
    projectId: id.optional(),
    assigneeKind: z.enum(ISSUE_ASSIGNEE_KINDS).optional(),
    label: label.optional(),
    priority: z.string().max(100).optional(),
    q: z.string().max(200).optional(),
    updatedSince: z.coerce.number().int().min(0).optional(),
    includeDeleted: z.enum(['0', '1', 'true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(ISSUE_LIMITS.listMax).optional(),
    cursor: z.string().max(256).optional(),
});
export type IssueListQuery = z.infer<typeof IssueListQuerySchema>;

// ─── Agent requests (wrapper-stamped `sessionId`; the agent cannot fill it) ───

/** POST /v1/issues/agent/update — status (agent subset) and/or a comment on the session's bound issue. */
export const IssueAgentUpdateSchema = z.object({
    sessionId: id,
    status: z.enum(ISSUE_AGENT_STATUSES).optional(),
    comment: commentBody.optional(),
    requestId: requestId.optional(),
}).refine(v => v.status !== undefined || v.comment !== undefined, 'status or comment required');
export type IssueAgentUpdate = z.infer<typeof IssueAgentUpdateSchema>;

/** POST /v1/issues/agent/comment. `mentionOwner` = 「@我」: becomes an owner mention and a 「需要我决策」 item. */
export const IssueAgentCommentSchema = z.object({
    sessionId: id,
    body: commentBody,
    mentionOwner: z.boolean().optional(),
    requestId: requestId.optional(),
});
export type IssueAgentComment = z.infer<typeof IssueAgentCommentSchema>;

// ─── Daemon worker requests ──────────────────────────────────────────────────

/** GET /v1/issues/dispatch?machineId=&workerVersion= → `IssueDispatchPollResponse`. Polled every 5 s; also records the worker as seen. */
export const IssueDispatchPollQuerySchema = z.object({
    machineId: id,
    workerVersion: z.coerce.number().int().min(1),
});
export const IssueDispatchClaimSchema = z.object({ machineId: id });
export const IssueDispatchCompleteSchema = z.object({
    machineId: id,
    claimId: id,
    /** `spawn`: the new session. `message`: the session it was delivered to. */
    sessionId: id,
});
export const IssueDispatchFailSchema = z.object({
    machineId: id,
    claimId: id,
    error: z.string().min(1).max(4000),
    /** True when the outcome is unknown (e.g. timeout after the spawn RPC); the server keeps the run `claimed` for owner retry instead of failing it. */
    unknown: z.boolean().optional(),
});
/** POST /v1/issues/runs/:runId/session-event — the daemon's view of the run's session. */
export const IssueRunSessionEventSchema = z.object({
    machineId: id,
    sessionId: id,
    event: z.enum(['running', 'idle', 'exited', 'crashed']),
});

// ─── MCP tool inputs (happy MCP inside the wrapper; snake_case like the other tools) ─

export const IssueGetToolInputSchema = z.object({
    /** `VH-12` / id; absent = the issue this session is bound to. */
    issue: z.string().min(1).max(128).optional(),
});
export const IssueUpdateToolInputSchema = z.object({
    status: z.enum(ISSUE_AGENT_STATUSES).optional(),
    comment: z.string().min(1).max(ISSUE_LIMITS.commentBytes).optional(),
}).refine(v => v.status !== undefined || v.comment !== undefined, 'status or comment required');
export const IssueCommentToolInputSchema = z.object({
    body: z.string().min(1).max(ISSUE_LIMITS.commentBytes),
    mention_owner: z.boolean().optional(),
});
export const IssueListToolInputSchema = z.object({
    status: z.array(z.enum(ISSUE_STATUSES)).max(ISSUE_STATUSES.length).optional(),
    project: z.enum(['current', 'any']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
});

// ─── Views (responses / update payloads) ─────────────────────────────────────

export type IssueAssigneeView =
    | { kind: 'none' }
    | { kind: 'self' }
    | { kind: 'agent'; machineId: string; agent: string; agentProfile?: AgentProfileRef | null; model?: string | null; permissionMode?: string | null; directory?: string; worktree?: boolean }
    | { kind: 'team'; teamId: string }
    /** A kind this client does not know (newer server). */
    | { kind: string; [key: string]: unknown };

export type IssueActorView = {
    kind: string;
    sessionId?: string | null;
    runId?: string | null;
};

/** Phase 2 (PR association) slot: never set by a phase-1 server; clients render nothing for it. */
export type IssueExternalLinkView = { kind: string; ref: string; title?: string | null; state?: string | null; updatedAt?: number };

export type IssueView = {
    id: string;
    number: number;
    /** `VH-<number>` (server-formatted so a later prefix change needs no client change). */
    key: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignee: IssueAssigneeView;
    projectId: string | null;
    labels: string[];
    dueAt: number | null;
    parentId: string | null;
    sortOrder: number;
    createdBy: IssueActorView;
    /** Run whose agent (or whose start) last set the status; null after a human change. Drives `issueStatusAfterRunFailure`. */
    statusRunId: string | null;
    /** Newest run of any status (null = never ran). */
    latestRunId: string | null;
    /** Id of the legacy `vh.todo.v1.<id>` record this issue was imported from. */
    legacyTodoId: string | null;
    links?: IssueExternalLinkView[];
    createdAt: number;
    updatedAt: number;
    statusChangedAt: number;
    startedAt: number | null;
    completedAt: number | null;
    deletedAt: number | null;
    /** Bumped on every mutation; clients keep the highest version per id. */
    version: number;
};

export type IssueCommentView = {
    id: string;
    issueId: string;
    kind: string;
    author: IssueActorView;
    /** Prose for `comment`; a short machine-written line for system kinds. */
    body: string;
    /** System entries: e.g. `{ from: 'todo', to: 'in_progress' }`. */
    data: Record<string, unknown> | null;
    mentions: { kind: string; agent?: string; machineId?: string }[];
    refSessionId: string | null;
    /** Where the comment went: run ids it was delivered to / started. Empty for notes and agent comments. */
    routedRunIds: string[];
    /** Owner mention handled (reply, ack, or issue closed). */
    ownerAckedAt: number | null;
    createdAt: number;
    editedAt: number | null;
    deletedAt: number | null;
};

export type IssueRunView = {
    id: string;
    issueId: string;
    /** 1-based per issue (「第 3 次执行」). */
    seq: number;
    trigger: string;
    triggerCommentId: string | null;
    status: string;
    agent: string;
    machineId: string;
    agentProfile: AgentProfileRef | null | undefined;
    model: string | null;
    permissionMode: string | null;
    directory: string | null;
    sessionId: string | null;
    error: string | null;
    /** A failed run the owner acknowledged (removes it from 「需要我决策」). */
    failureAckedAt: number | null;
    createdAt: number;
    claimedAt: number | null;
    startedAt: number | null;
    endedAt: number | null;
};

export type IssueDispatchView = {
    id: string;
    kind: string;
    issueId: string;
    runId: string;
    machineId: string;
    /** spawn: everything the daemon needs to start the session. */
    spawn?: {
        agent: string;
        directory: string;
        agentProfile?: AgentProfileRef | null;
        model?: string | null;
        permissionMode?: string | null;
        projectId: string | null;
        /** Full first user message (issue block + rules), built by the server with `buildIssueInitialPrompt`. */
        prompt: string;
    };
    /** message: the session to deliver into and the text (comment + one-line rules reminder). */
    message?: { sessionId: string; text: string; commentId: string };
    claimId: string | null;
    createdAt: number;
};

export type IssueDispatchPollResponse = { dispatches: IssueDispatchView[] };
export type IssueMutationResponse = { issue: IssueView; runs?: IssueRunView[]; comment?: IssueCommentView };
export type IssueListResponse = {
    issues: IssueView[];
    nextCursor: string | null;
    asOf: number;
    /** The `latestRunId` run of each issue on this page that has one (lets the list show run state without a detail fetch). Absent from older servers. */
    latestRuns?: IssueRunView[];
};
export type IssueDetailResponse = { issue: IssueView; comments: IssueCommentView[]; runs: IssueRunView[]; children: Pick<IssueView, 'id' | 'key' | 'title' | 'status'>[] };

/** GET /v1/issues/session/:sessionId — what `issue_*` tools and the next-turn digest need. `issue: null` = session not bound. */
export type IssueSessionContext = {
    issue: IssueView | null;
    run: IssueRunView | null;
    /** True when this session's run is the issue's current one (writes allowed). */
    current: boolean;
    comments: IssueCommentView[];
    asOf: number;
};

/** Machines whose issue worker polled recently (assignee picker hides the rest with 「CLI 过旧 / 离线」). */
export type IssueWorkersResponse = { workers: { machineId: string; workerVersion: number; lastSeenAt: number }[] };

/** POST /v1/issues/import-legacy-todos — idempotent, re-runnable. */
export type IssueTodoImportResult = { imported: number; updated: number; skipped: number; conflicts: number; invalid: number };

// ─── Socket updates (user-scoped, full snapshots, never hard-deleted) ────────

export const UpdateIssueBodySchema = z.object({
    t: z.literal('issue'),
    issue: z.object({ id: z.string(), version: z.number() }).passthrough(),
});
export const UpdateIssueCommentBodySchema = z.object({
    t: z.literal('issue-comment'),
    comment: z.object({ id: z.string(), issueId: z.string() }).passthrough(),
});
export const UpdateIssueRunBodySchema = z.object({
    t: z.literal('issue-run'),
    run: z.object({ id: z.string(), issueId: z.string(), status: z.string() }).passthrough(),
});
export type UpdateIssueBody = { t: 'issue'; issue: IssueView };
export type UpdateIssueCommentBody = { t: 'issue-comment'; comment: IssueCommentView };
export type UpdateIssueRunBody = { t: 'issue-run'; run: IssueRunView };

/** Narrow error codes clients can branch on. */
export const ISSUE_ERROR_CODES = [
    'issues_disabled', 'issue_not_found', 'issue_version_conflict', 'issue_count_quota_exceeded',
    'issue_status_forbidden', 'issue_closed', 'issue_comment_required', 'issue_not_bound', 'issue_run_not_current',
    'issue_assignee_unsupported', 'issue_agent_unsupported', 'issue_no_directory', 'issue_machine_not_found',
    'issue_parent_cycle', 'issue_project_not_found', 'issue_comment_quota_exceeded',
    'issue_run_not_found', 'issue_dispatch_claim_mismatch', 'transaction_conflict',
] as const;
export type IssueErrorCode = typeof ISSUE_ERROR_CODES[number];

// ─── Prompts (server builds them; text shared so tests pin one copy) ─────────

/** Status rules every issue run gets (spec §5). English like `AGENT_GUIDANCE`. */
export const ISSUE_STATUS_RULES = [
    'Issue status rules (Very Happy):',
    '- When you start working, call mcp__happy__issue_update with status "in_progress".',
    '- When you deliver, call issue_update with status "in_review" and a comment saying what you did and how it was verified.',
    '- When you are stuck, call issue_update with status "blocked" and a comment saying exactly what you need.',
    '- If you only answered a question, reply with issue_comment and leave the status alone.',
    '- Never try to set "done" or "cancelled": only the owner closes an issue.',
].join('\n');

/** One line appended to every delivered comment, so the rules survive long sessions and compaction. */
export const ISSUE_RULES_REMINDER = 'Reply on the issue with mcp__happy__issue_comment / issue_update (in_progress → in_review with a summary, or blocked with what you need; never done).';

type PromptIssue = Pick<IssueView, 'key' | 'title' | 'description' | 'status' | 'priority' | 'labels' | 'dueAt'>;
type PromptComment = Pick<IssueCommentView, 'kind' | 'author' | 'body' | 'createdAt'>;

function commentLine(c: PromptComment): string {
    const who = c.author.kind === 'agent' ? 'agent' : c.author.kind === 'user' ? 'owner' : c.author.kind;
    return `- [${who}] ${c.body.replace(/\s+/g, ' ').slice(0, 600)}`;
}

/** First user message of a run. Project instructions are not repeated here: the B-645 injector prefixes them. */
export function buildIssueInitialPrompt(input: { issue: PromptIssue; comments: readonly PromptComment[]; trigger: string; triggerComment?: PromptComment | null }): string {
    const { issue } = input;
    const meta = [`status: ${issue.status}`, `priority: ${issue.priority}`];
    if (issue.labels.length) meta.push(`labels: ${issue.labels.join(', ')}`);
    if (issue.dueAt) meta.push(`due: ${new Date(issue.dueAt).toISOString().slice(0, 10)}`);
    const recent = input.comments.filter(c => c.kind === 'comment').slice(-ISSUE_LIMITS.contextComments);
    const parts = [
        `You are assigned issue ${issue.key}: ${issue.title}`,
        meta.join(' · '),
        '',
        issue.description.trim() || '(no description)',
    ];
    if (recent.length) parts.push('', 'Recent comments (oldest first):', ...recent.map(commentLine));
    if (input.triggerComment) parts.push('', `You were started by this comment:`, commentLine(input.triggerComment));
    parts.push('', ISSUE_STATUS_RULES);
    return parts.join('\n');
}

/** Text the daemon delivers into a live run session for a new human comment. */
export function buildIssueCommentPrompt(input: { issue: Pick<IssueView, 'key' | 'title' | 'status'>; comment: PromptComment }): string {
    return [
        `New comment on ${input.issue.key} (${input.issue.title}, status ${input.issue.status}):`,
        input.comment.body,
        '',
        ISSUE_RULES_REMINDER,
    ].join('\n');
}

// ─── Legacy Todos import (spec §8) ───────────────────────────────────────────

export type IssueLegacyTodoImport = {
    legacyTodoId: string;
    legacyTodoVersion: number;
    title: string;
    description: string;
    status: IssueStatus;
    assignee: { kind: 'none' };
    sortOrder: number;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
};

/** `vh.todo.v1.<id>` record → issue fields. open → todo, done → done; no assignee (a todo is an unassigned issue). Titles over the issue limit are cut. */
export function issueFromLegacyTodo(todo: BuiltinTodo, version: number): IssueLegacyTodoImport {
    return {
        legacyTodoId: todo.id,
        legacyTodoVersion: version,
        title: todo.title.trim().slice(0, ISSUE_LIMITS.titleChars),
        description: todo.note,
        status: todo.status === 'done' ? 'done' : 'todo',
        assignee: { kind: 'none' },
        sortOrder: todo.order,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
        completedAt: todo.status === 'done' ? todo.updatedAt : null,
    };
}

/**
 * Re-run rule: a KV record newer than what was imported overwrites the issue
 * only if nobody touched the issue since the import; otherwise it is a
 * conflict (the issue wins, the server adds a system comment with the KV text).
 */
export function legacyTodoReimportAction(input: { kvVersion: number; importedVersion: number; issueChangedSinceImport: boolean }): 'skip' | 'update' | 'conflict' {
    if (input.kvVersion <= input.importedVersion) return 'skip';
    return input.issueChangedSinceImport ? 'conflict' : 'update';
}
