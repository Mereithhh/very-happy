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
export const AUTOMATION_DEFAULT_MAX_RUNTIME_MS = 6 * 3_600_000;
export const AUTOMATION_SCRIPT_DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const AUTOMATION_DEFAULT_LEASE_MS = 60_000;
export const AUTOMATION_CLAIM_MAX_RUNS = 8;
export const AUTOMATION_DEDUPE_WINDOW_MS = 24 * 3_600_000;
export const AUTOMATION_QUEUED_ATTENTION_MS = 10 * 60_000;
export const AUTOMATION_RUN_RETENTION = 200;

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
});
export type AutomationClaim = z.infer<typeof AutomationClaimSchema>;

// Fencing: `claimId` is issued by the claim response; only its holder may
// report. Omitting `status` only renews the lease (and may attach session /
// sticky / attention). Terminal statuses are final.
export const AutomationReportSchema = z.object({
    claimId: id,
    status: z.enum(['running', 'done', 'failed']).optional(),
    sessionId: id.nullable().optional(),
    stickyKey: z.string().min(1).max(512).optional(),
    summary: z.string().max(AUTOMATION_SUMMARY_MAX_CHARS).nullable().optional(),
    error: z.string().max(AUTOMATION_SUMMARY_MAX_CHARS).nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    needsAttention: z.boolean().optional(),
    attentionReason: z.string().max(512).nullable().optional(),
    leaseMs: z.number().int().min(5_000).max(3_600_000).optional(),
});
export type AutomationReport = z.infer<typeof AutomationReportSchema>;

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
};
export type AutomationSticky = { key: string; sessionId: string; updatedAt: number };
export type AutomationClaimedRun = { run: AutomationRun & { claimId: string }; automation: Automation; stickies: AutomationSticky[] };
export type AutomationClaimResponse = { runs: AutomationClaimedRun[]; leaseMs: number };
export type AutomationFireResponse = { run: AutomationRun; deduplicated: boolean };
export type AutomationErrorResponse = { error: string; status?: AutomationRunStatus };
