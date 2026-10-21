import { z } from 'zod';

/**
 * B-644 Projects (`specs/2026-10-projects.md`): a long-lived, account-owned
 * container for human-written instructions, an agent-writable log, member
 * sessions and default settings. Stored server-side in plaintext (same trust
 * tier as Teams). Every field added here must stay optional on the wire so an
 * older client simply ignores it (AGENTS rule 4).
 */

/** Session capability a wrapper advertises in `metadata.capabilities` once it can read/inject project context. */
export const PROJECT_SESSION_CAPABILITY = 'project-v1';

export const PROJECT_LIMITS = {
    nameChars: 120,
    goalChars: 2000,
    instructionsBytes: 8 * 1024,
    folders: 20,
    logTitleChars: 200,
    logBodyBytes: 4 * 1024,
    messageBytes: 64 * 1024,
    /** Per author session, rolling hour. */
    notesPerHour: 5,
    decisionsPerHour: 2,
    presenceBatch: 200,
    memberBatch: 200,
    /** Delivered offline-message bodies are erased after this long (Q4). */
    deliveredMessageRetentionMs: 7 * 86400_000,
} as const;

const id = z.string().min(1).max(128);
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const boundedText = (maxBytes: number) => z.string().max(maxBytes).refine(v => utf8Bytes(v) <= maxBytes, `exceeds ${maxBytes} bytes`);

export const ProjectFolderSchema = z.object({
    machineId: id,
    path: z.string().min(1).max(4096),
    primary: z.boolean().optional(),
});
export type ProjectFolder = z.infer<typeof ProjectFolderSchema>;

/**
 * Defaults snapshot for new sessions/teams. Mode-like strings stay open
 * (`string().nullable().optional()`, AGENTS rule 14): readers whitelist, an
 * unknown value never drops the whole object.
 */
export const ProjectDefaultsSchema = z.object({
    agent: z.string().max(64).nullable().optional(),
    model: z.string().max(256).nullable().optional(),
    permissionMode: z.string().max(64).nullable().optional(),
    worktree: z.boolean().nullable().optional(),
});
export type ProjectDefaults = z.infer<typeof ProjectDefaultsSchema>;

export const PROJECT_LOG_KINDS = ['decision', 'finding', 'handoff'] as const;
export const ProjectLogKindSchema = z.enum(PROJECT_LOG_KINDS);
export type ProjectLogKind = z.infer<typeof ProjectLogKindSchema>;

/** How a session became a member. `team` is derived at read time from an attached team and never stored. */
export const PROJECT_MEMBER_VIA = ['explicit', 'lineage', 'suggested-accepted', 'team', 'automation'] as const;
export type ProjectMemberVia = typeof PROJECT_MEMBER_VIA[number];
/** Stored values (a client may not claim `team`). Kept as an open string on read so a newer value never breaks an older reader. */
export const ProjectMemberViaInputSchema = z.enum(['explicit', 'lineage', 'suggested-accepted', 'automation']);

export const ProjectCreateSchema = z.object({
    name: z.string().trim().min(1).max(PROJECT_LIMITS.nameChars),
    goal: z.string().max(PROJECT_LIMITS.goalChars).nullable().optional(),
    instructions: boundedText(PROJECT_LIMITS.instructionsBytes).optional(),
    folders: z.array(ProjectFolderSchema).max(PROJECT_LIMITS.folders).optional(),
    defaults: ProjectDefaultsSchema.optional(),
    /** Idempotency: the same requestId returns the project it created. */
    requestId: id.optional(),
    /** Optional initial members (e.g. "设为项目" moves a folder's sessions in one step). */
    sessionIds: z.array(id).max(PROJECT_LIMITS.memberBatch).optional(),
});
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

export const ProjectUpdateSchema = z.object({
    name: z.string().trim().min(1).max(PROJECT_LIMITS.nameChars).optional(),
    goal: z.string().max(PROJECT_LIMITS.goalChars).nullable().optional(),
    folders: z.array(ProjectFolderSchema).max(PROJECT_LIMITS.folders).optional(),
    defaults: ProjectDefaultsSchema.optional(),
    archived: z.boolean().optional(),
});
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

/** CAS write: `ifVersion` must equal the current `instructionsVersion`, otherwise 409 with the latest project. */
export const ProjectInstructionsPutSchema = z.object({
    instructions: boundedText(PROJECT_LIMITS.instructionsBytes),
    ifVersion: z.number().int().min(0),
    /** One-line summary shown in the next-turn digest ("instructions now v8 — …"). */
    summary: z.string().max(200).optional(),
});
export type ProjectInstructionsPut = z.infer<typeof ProjectInstructionsPutSchema>;

export const ProjectMembersAddSchema = z.object({
    sessionIds: z.array(id).min(1).max(PROJECT_LIMITS.memberBatch),
    via: ProjectMemberViaInputSchema.optional(),
});
export type ProjectMembersAdd = z.infer<typeof ProjectMembersAddSchema>;

export const ProjectLogCreateSchema = z.object({
    kind: ProjectLogKindSchema,
    title: z.string().trim().min(1).max(PROJECT_LIMITS.logTitleChars),
    body: boundedText(PROJECT_LIMITS.logBodyBytes).optional(),
    /** Entry id (or `#seq`) this entry replaces. */
    supersedes: z.string().min(1).max(128).optional(),
    /** Stamped by the wrapper (the agent cannot fill it). Absent = written by the user. */
    authorSessionId: id.optional(),
});
export type ProjectLogCreate = z.infer<typeof ProjectLogCreateSchema>;

export const ProjectLogRevokeSchema = z.object({
    /** When set, only entries this session authored may be revoked. Absent = the owner. */
    bySessionId: id.optional(),
});

export const ProjectAttachTeamSchema = z.object({ teamId: id });

export const ProjectPresenceEntrySchema = z.object({
    sessionId: id,
    title: z.string().max(200).nullable().optional(),
    agent: z.string().max(64).nullable().optional(),
    machine: z.string().max(200).nullable().optional(),
    branch: z.string().max(200).nullable().optional(),
    state: z.string().max(32).nullable().optional(),
    doing: z.string().max(200).nullable().optional(),
    injectedInstructionsVersion: z.number().int().min(0).nullable().optional(),
    /** Session capabilities the wrapper advertised (e.g. `project-v1`); drives the "未注入" badge. */
    capabilities: z.array(z.string().max(64)).max(32).optional(),
});
export type ProjectPresenceEntry = z.infer<typeof ProjectPresenceEntrySchema>;

export const ProjectPresencePutSchema = z.object({
    machineId: id,
    sessions: z.array(ProjectPresenceEntrySchema).max(PROJECT_LIMITS.presenceBatch),
    /** Sessions of this machine that stopped; their presence rows are marked `offline`. */
    gone: z.array(id).max(PROJECT_LIMITS.presenceBatch).optional(),
});
export type ProjectPresencePut = z.infer<typeof ProjectPresencePutSchema>;

export const ProjectMessageCreateSchema = z.object({
    fromSessionId: id,
    toSessionId: id,
    body: boundedText(PROJECT_LIMITS.messageBytes).pipe(z.string().min(1)),
});
export type ProjectMessageCreate = z.infer<typeof ProjectMessageCreateSchema>;

export const ProjectMessagesDeliveredSchema = z.object({
    sessionId: id,
    messageIds: z.array(id).min(1).max(100),
});

export const ProjectSessionContextQuerySchema = z.object({
    full: z.enum(['0', '1', 'true', 'false']).optional(),
    section: z.enum(['instructions', 'log', 'sessions', 'messages']).optional(),
    /** Read without moving the "since last read" cursor (used by the first-turn prefix). */
    peek: z.enum(['0', '1', 'true', 'false']).optional(),
});

export const ProjectDigestQuerySchema = z.object({
    since: z.coerce.number().int().min(0),
});

// ─── Views ────────────────────────────────────────────────────────────────

export type ProjectView = {
    id: string;
    name: string;
    goal: string | null;
    instructions: string;
    instructionsVersion: number;
    instructionsUpdatedBy: string | null;
    instructionsUpdatedAt: number | null;
    folders: ProjectFolder[];
    defaults: ProjectDefaults;
    archivedAt: number | null;
    createdAt: number;
    updatedAt: number;
    /** Teams attached to this project (`AgentTeam.projectId`). */
    teamIds: string[];
    /** Automations attached to this project (`Automation.projectId`). */
    automationIds: string[];
};

export type ProjectMemberView = {
    projectId: string;
    sessionId: string;
    via: string;
    machineId: string | null;
    teamId?: string;
    createdAt: number;
};

export type ProjectLogEntryView = {
    id: string;
    seq: number;
    projectId: string;
    kind: ProjectLogKind;
    title: string;
    body: string;
    authorSessionId: string | null;
    authorUser: boolean;
    supersedes: string | null;
    supersededBy: string | null;
    revokedAt: number | null;
    createdAt: number;
};

export type ProjectPresenceView = {
    sessionId: string;
    projectId: string;
    machineId: string;
    title: string | null;
    agent: string | null;
    machine: string | null;
    branch: string | null;
    state: string | null;
    doing: string | null;
    injectedInstructionsVersion: number | null;
    capabilities: string[];
    updatedAt: number;
};

export type ProjectMessageView = {
    id: string;
    projectId: string;
    fromSessionId: string;
    toSessionId: string;
    /** Null once erased (delivered + 7 days). */
    body: string | null;
    deliveredAt: number | null;
    createdAt: number;
};

export type ProjectInstructionsRevisionView = {
    version: number;
    instructions: string;
    updatedBy: string | null;
    summary: string | null;
    createdAt: number;
};

export type ProjectListResponse = { projects: ProjectView[]; members: ProjectMemberView[] };
export type ProjectDetailResponse = {
    project: ProjectView;
    members: ProjectMemberView[];
    presence: ProjectPresenceView[];
    log: ProjectLogEntryView[];
};

/** What a wrapper needs to build the first-turn prefix (P) and answer `project_context`. */
export type ProjectSessionContext = {
    project: Pick<ProjectView, 'id' | 'name' | 'goal' | 'instructions' | 'instructionsVersion'> | null;
    via: string | null;
    /** `lead` (B-726) is absent from older servers; true when this session is the team's root bot. */
    team: { id: string; name: string; lead?: boolean } | null;
    decisions: Pick<ProjectLogEntryView, 'id' | 'seq' | 'title' | 'createdAt'>[];
    log: ProjectLogEntryView[];
    sessions: ProjectPresenceView[];
    unread: Pick<ProjectMessageView, 'id' | 'fromSessionId' | 'body' | 'createdAt'>[];
    /** Server time of this read; pass back as `since` for the next digest. */
    asOf: number;
    /** Cursor the server held before this read (0 = never read). */
    previousReadAt: number;
};

/** Next-turn piggyback (D): only what changed since `since`. Empty arrays and null mean nothing to say. */
export type ProjectDigest = {
    projectId: string | null;
    name: string | null;
    instructions: { version: number; summary: string | null } | null;
    decisions: Pick<ProjectLogEntryView, 'id' | 'seq' | 'title'>[];
    revoked: Pick<ProjectLogEntryView, 'id' | 'seq' | 'title'>[];
    messages: Pick<ProjectMessageView, 'id' | 'fromSessionId' | 'body' | 'createdAt'>[];
    asOf: number;
};

/** Narrow error codes clients can branch on. */
export const PROJECT_ERROR_CODES = [
    'projects_disabled', 'project_not_found', 'project_count_quota_exceeded', 'session_not_found', 'session_not_owned',
    'instructions_version_conflict', 'project_note_quota_exceeded', 'log_entry_not_found', 'log_entry_not_owned',
    'team_not_found', 'team_machine_not_in_project', 'not_a_project_member', 'message_quota_exceeded',
    'project_presence_rate_quota_exceeded', 'transaction_conflict', 'invalid_folders',
] as const;
export type ProjectErrorCode = typeof PROJECT_ERROR_CODES[number];

// ─── B-651 UX telemetry (counts and durations only; no titles, ids or text) ──

export const PROJECT_UX_DISPATCH_ENTRIES = ['quick', 'dialog', 'project', 'sidebar_group', 'move', 'other'] as const;
export const ProjectUxEventSchema = z.discriminatedUnion('kind', [
    /** A session was created (or moved) — where from, and whether it landed in a project. */
    z.object({ kind: z.literal('dispatch'), entry: z.enum(PROJECT_UX_DISPATCH_ENTRIES), inProject: z.boolean() }),
    /** The owner opened a session that was waiting for them: how long it had been waiting. */
    z.object({ kind: z.literal('attention_open'), latencyMs: z.number().int().min(0).max(7 * 86400_000), inProject: z.boolean() }),
]);
export type ProjectUxEvent = z.infer<typeof ProjectUxEventSchema>;
export const ProjectUxBatchSchema = z.object({ events: z.array(ProjectUxEventSchema).min(1).max(20) });
