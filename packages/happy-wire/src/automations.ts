import { z } from 'zod';

// B-496 account-level Automations. Request schemas are strict (the server
// validates them); response shapes are plain TS types like `TeamState`, so
// clients tolerate fields and enum values added by newer servers (AGENTS #4/#14).

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(32000);
export const AUTOMATION_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
export const AutomationNameSchema = z.string().regex(AUTOMATION_NAME_PATTERN, 'automation name must match [a-z0-9][a-z0-9-_.]{0,63}');
export const AUTOMATION_MIN_INTERVAL_MS = 60_000;
export const AUTOMATION_MAX_INTERVAL_MS = 366 * 86_400_000;
export const AUTOMATION_MAX_TIMESTAMP = 8_640_000_000_000_000;
export const AUTOMATION_PAYLOAD_MAX_BYTES = 65_536;
export const AUTOMATION_SUMMARY_MAX_CHARS = 4096;
export const AUTOMATION_ATTENTION_REASON_MAX_CHARS = 512;
export const AUTOMATION_DEFAULT_MAX_RUNTIME_MS = 6 * 3_600_000;
export const AUTOMATION_SCRIPT_DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const AUTOMATION_DEFAULT_LEASE_MS = 60_000;
export const AUTOMATION_CLAIM_MAX_RUNS = 8;
export const AUTOMATION_DEDUPE_WINDOW_MS = 24 * 3_600_000;
export const AUTOMATION_QUEUED_ATTENTION_MS = 10 * 60_000;
export const AUTOMATION_RUN_RETENTION = 200;
// B-548 precheck: a cheap command the daemon runs before the action; exit 0 runs the action, anything else records a skip.
export const AUTOMATION_PRECHECK_DEFAULT_TIMEOUT_MS = 60_000;
export const AUTOMATION_PRECHECK_MAX_TIMEOUT_MS = 600_000;
export const AUTOMATION_PRECHECK_OUTPUT_MAX_CHARS = 4000;
/** Announced in `AutomationClaim.capabilities` by daemons that execute prechecks; the server never hands a precheck run to a daemon without it. */
export const AUTOMATION_DAEMON_CAPABILITY_PRECHECK = 'precheck';
/**
 * Reason codes a `skipped` run carries in `error` (B-548). Consecutive skips of
 * one automation's scheduled runs with the same reason fold into the newest run
 * (`occurrenceCount`). Clients show unknown codes verbatim.
 */
export const AUTOMATION_SKIP_REASONS = ['previous_run_active', 'precheck_failed', 'precheck_timeout', 'precheck_error', 'precheck_unsupported_cli'] as const;
export type AutomationSkipReason = typeof AUTOMATION_SKIP_REASONS[number];

const timestamp = z.number().int().positive().max(AUTOMATION_MAX_TIMESTAMP);
export const AutomationTriggerSchema = z.discriminatedUnion('kind', [
    // `expr` is standard five-field cron (minute hour day-of-month month day-of-week,
    // plus @hourly/@daily/@weekly/@monthly/@yearly); `tz` is an IANA zone.
    z.object({ kind: z.literal('cron'), expr: z.string().trim().min(1).max(256), tz: z.string().trim().min(1).max(64) }),
    // Fires at anchorAt + k * everyMs. Omitted anchorAt defaults to creation time on the server.
    z.object({ kind: z.literal('interval'), everyMs: z.number().int().min(AUTOMATION_MIN_INTERVAL_MS).max(AUTOMATION_MAX_INTERVAL_MS), anchorAt: timestamp.optional() }),
    z.object({ kind: z.literal('once'), at: timestamp }),
    z.object({ kind: z.literal('manual') }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationStickySchema = z.object({ key: z.string().min(1).max(512) });
export const AutomationActionSchema = z.discriminatedUnion('kind', [
    // `agent` and `permissionMode` are open strings (AGENTS #14): the daemon
    // resolves them against its own allowlists at execution time.
    z.object({
        kind: z.literal('spawn'),
        agent: z.string().trim().min(1).max(64),
        directory: z.string().min(1).max(4096),
        prompt: text,
        model: z.string().trim().min(1).max(256).nullable().optional(),
        permissionMode: z.string().trim().min(1).max(64).nullable().optional(),
        worktree: z.boolean().optional(),
        sticky: AutomationStickySchema.optional(),
    }),
    z.object({ kind: z.literal('send'), sessionId: id, prompt: text }),
    z.object({
        kind: z.literal('script'),
        command: z.array(z.string().min(1).max(4096)).min(1).max(256),
        cwd: z.string().min(1).max(4096).optional(),
        env: z.record(z.string().min(1).max(256), z.string().max(32000)).optional(),
        timeoutMs: z.number().int().min(1000).max(7 * 86_400_000).optional(),
    }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

/**
 * B-548: optional gate before the action. Exactly one of `command` (argv, no
 * shell; templates rendered like a script's argv) or `shell` (one command line
 * run by the platform shell; NOT template-rendered — read the payload from
 * `$VH_AUTOMATION_PAYLOAD`). `cwd` defaults to the action's directory / cwd,
 * else the daemon's home. `includeOutput` appends the precheck's stdout to a
 * spawn/send prompt.
 */
export const AutomationPrecheckSchema = z.object({
    command: z.array(z.string().min(1).max(4096)).min(1).max(256).optional(),
    shell: z.string().trim().min(1).max(8000).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(AUTOMATION_PRECHECK_MAX_TIMEOUT_MS).optional(),
    includeOutput: z.boolean().optional(),
}).refine((p) => (p.command === undefined) !== (p.shell === undefined), 'precheck needs exactly one of command (argv) or shell');
export type AutomationPrecheck = z.infer<typeof AutomationPrecheckSchema>;

export const AutomationConcurrencySchema = z.enum(['skip', 'queue']);
export type AutomationConcurrency = z.infer<typeof AutomationConcurrencySchema>;
export const AUTOMATION_STATUSES = ['active', 'paused'] as const;
export type AutomationStatus = typeof AUTOMATION_STATUSES[number];
export const AUTOMATION_RUN_STATUSES = ['queued', 'claimed', 'running', 'done', 'failed', 'skipped', 'expired', 'cancelled'] as const;
export type AutomationRunStatus = typeof AUTOMATION_RUN_STATUSES[number];
export const AUTOMATION_RUN_TERMINAL_STATUSES: readonly AutomationRunStatus[] = ['done', 'failed', 'skipped', 'expired', 'cancelled'];
export const AUTOMATION_RUN_SOURCES = ['schedule', 'fire', 'manual'] as const;
export type AutomationRunSource = typeof AUTOMATION_RUN_SOURCES[number];
export function isAutomationRunTerminal(status: string): boolean {
    return (AUTOMATION_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

const maxRuntimeMs = z.number().int().min(60_000).max(7 * 86_400_000);
export const AutomationCreateSchema = z.object({
    name: AutomationNameSchema,
    description: z.string().max(4000).nullable().optional(),
    machineId: id,
    trigger: AutomationTriggerSchema,
    action: AutomationActionSchema,
    concurrency: AutomationConcurrencySchema.optional(),
    maxRuntimeMs: maxRuntimeMs.optional(),
    status: z.enum(AUTOMATION_STATUSES).optional(),
    /** B-548. Older servers strip it silently — clients must check the response echoes `precheck`. */
    precheck: AutomationPrecheckSchema.nullable().optional(),
    /** B-644: sessions this automation spawns join this project (quiet variant). Older servers strip it — check the echo. */
    projectId: id.nullable().optional(),
});
export type AutomationCreate = z.infer<typeof AutomationCreateSchema>;
export const AutomationUpdateSchema = z.object({
    version: z.number().int().positive(),
    name: AutomationNameSchema.optional(),
    description: z.string().max(4000).nullable().optional(),
    machineId: id.optional(),
    trigger: AutomationTriggerSchema.optional(),
    action: AutomationActionSchema.optional(),
    concurrency: AutomationConcurrencySchema.optional(),
    maxRuntimeMs: maxRuntimeMs.optional(),
    /** B-548: omitted keeps the current precheck, `null` removes it. Changing `action` alone keeps it too. */
    precheck: AutomationPrecheckSchema.nullable().optional(),
    /** B-644: omitted keeps the current project, `null` detaches. */
    projectId: id.nullable().optional(),
});
export type AutomationUpdate = z.infer<typeof AutomationUpdateSchema>;

const payload = z.string().max(AUTOMATION_PAYLOAD_MAX_BYTES).refine(v => new TextEncoder().encode(v).length <= AUTOMATION_PAYLOAD_MAX_BYTES, 'payload exceeds 64KB');
export const AutomationFireSchema = z.object({ payload: payload.optional(), dedupeKey: z.string().min(1).max(256).optional() });
export type AutomationFire = z.infer<typeof AutomationFireSchema>;
export const AutomationManualRunSchema = z.object({ payload: payload.optional() });
export type AutomationManualRun = z.infer<typeof AutomationManualRunSchema>;

export const AutomationClaimSchema = z.object({
    machineId: id,
    limit: z.number().int().min(1).max(AUTOMATION_CLAIM_MAX_RUNS).optional(),
    leaseMs: z.number().int().min(5_000).max(3_600_000).optional(),
    /** B-548: what this daemon can execute (e.g. `precheck`). Older daemons send nothing; older servers strip it. */
    capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
});
export type AutomationClaim = z.infer<typeof AutomationClaimSchema>;

// Two report shapes share one schema:
// - daemon (with `claimId`, issued by the claim response): fenced; omitting
//   `status` only renews the lease, and session / sticky / lease fields apply.
// - account-level explicit outcome (no `claimId`, e.g. `automation_report` from
//   inside the session): `status` must be done|failed; only summary / error /
//   exitCode / attention are applied, never lease, session or sticky.
// Terminal statuses are final either way. `skipped` (B-548, a precheck that did
// not pass) is daemon-only and carries its reason code in `error`.
export const AutomationReportSchema = z.object({
    claimId: id.optional(),
    status: z.enum(['running', 'done', 'failed', 'skipped']).optional(),
    sessionId: id.nullable().optional(),
    stickyKey: z.string().min(1).max(512).optional(),
    summary: z.string().max(AUTOMATION_SUMMARY_MAX_CHARS).nullable().optional(),
    error: z.string().max(AUTOMATION_SUMMARY_MAX_CHARS).nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    needsAttention: z.boolean().optional(),
    attentionReason: z.string().max(AUTOMATION_ATTENTION_REASON_MAX_CHARS).nullable().optional(),
    leaseMs: z.number().int().min(5_000).max(3_600_000).optional(),
});
export type AutomationReport = z.infer<typeof AutomationReportSchema>;

// B-508: who / what cleared the attention flag. `owner` is the explicit
// 「知道了」; the server also clears on the owner's own reply in a linked
// session, on a later `done` report, and on a user-intent archive.
export const AUTOMATION_ACK_BY = ['owner', 'owner-replied', 'run-done', 'report', 'session-archived', 'cancelled', 'machine-back'] as const;
export type AutomationAckBy = typeof AUTOMATION_ACK_BY[number];
export const AutomationAckSchema = z.object({ by: z.string().min(1).max(64).optional() });
export type AutomationAck = z.infer<typeof AutomationAckSchema>;

export const AutomationStickyPutSchema = z.object({ key: z.string().min(1).max(512), sessionId: id });
export const AutomationStickyDeleteSchema = z.object({ key: z.string().min(1).max(512) });
export const AutomationRunsQuerySchema = z.object({
    automationId: id.optional(),
    name: AutomationNameSchema.optional(),
    status: z.string().min(1).max(64).optional(),
    attention: z.enum(['1', 'true', '0', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const AutomationListQuerySchema = z.object({ machineId: id.optional() });

export type Automation = {
    id: string;
    name: string;
    description: string | null;
    machineId: string;
    status: AutomationStatus;
    trigger: AutomationTrigger;
    action: AutomationAction;
    concurrency: AutomationConcurrency;
    maxRuntimeMs: number;
    nextRunAt: number | null;
    version: number;
    lastRunAt: number | null;
    lastRunStatus: AutomationRunStatus | null;
    createdAt: number;
    updatedAt: number;
    /** B-548: the gate before the action; `null` = none. Absent on older servers (which also drop it on create/update). */
    precheck?: AutomationPrecheck | null;
    /** B-644: owning project; absent on older servers. */
    projectId?: string | null;
};
export type AutomationRun = {
    id: string;
    automationId: string;
    automationName: string;
    machineId: string;
    source: AutomationRunSource;
    dedupeKey: string | null;
    payload: string | null;
    status: AutomationRunStatus;
    needsAttention: boolean;
    attentionReason: string | null;
    /** B-508: when `needsAttention` last became true; absent on older servers. */
    attentionAt?: number | null;
    ackedAt?: number | null;
    /** B-508: `AutomationAckBy` vocabulary (or a newer value); absent on older servers. */
    ackedBy?: string | null;
    /** B-508: sessions this run is about — `sessionId` plus the ones its payload names. Absent on older servers. */
    linkedSessionIds?: string[];
    sessionId: string | null;
    stickyKey: string | null;
    scheduledFor: number | null;
    claimedAt: number | null;
    leaseUntil: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    summary: string | null;
    error: string | null;
    exitCode: number | null;
    createdAt: number;
    updatedAt: number;
    /** B-548: consecutive same-reason skips folded into this run (absent = 1). */
    occurrenceCount?: number;
};
export type AutomationSticky = { key: string; sessionId: string; updatedAt: number };
export type AutomationClaimedRun = { run: AutomationRun & { claimId: string }; automation: Automation; stickies: AutomationSticky[] };
export type AutomationClaimResponse = { runs: AutomationClaimedRun[]; leaseMs: number };
export type AutomationFireResponse = { run: AutomationRun; deduplicated: boolean };
export type AutomationErrorResponse = { error: string; status?: AutomationRunStatus };
