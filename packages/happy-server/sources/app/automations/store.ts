import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    AUTOMATION_CLAIM_MAX_RUNS, AUTOMATION_DEDUPE_WINDOW_MS, AUTOMATION_DEFAULT_LEASE_MS, AUTOMATION_DEFAULT_MAX_RUNTIME_MS,
    AUTOMATION_QUEUED_ATTENTION_MS, AUTOMATION_RUN_RETENTION, AUTOMATION_SCRIPT_DEFAULT_MAX_RUNTIME_MS, AUTOMATION_RUN_STATUSES,
    AUTOMATION_RUN_TERMINAL_STATUSES, isAutomationRunTerminal,
    type Automation, type AutomationClaim, type AutomationClaimResponse, type AutomationCreate, type AutomationFire, type AutomationFireResponse,
    type AutomationManualRun, type AutomationReport, type AutomationRun, type AutomationRunStatus, type AutomationSticky, type AutomationUpdate,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { inTx, isRetryableTransactionConflict, type Tx } from '@/storage/inTx';
import { configuredResourceLimit } from '@/app/api/resourceLimits';
import { AutomationError, requireAutomation } from './errors';
import { initialRunAt, nextRunAfter, normalizeTrigger } from './schedule';

/**
 * Account-level Automations (B-496). Every mutation runs in a SERIALIZABLE
 * transaction (`inTx` retries P2034 / P2010+40001), so concurrent claims and
 * fires cannot double-materialize or double-claim a run.
 */
type AutomationRow = Prisma.AutomationGetPayload<{}>;
type RunRow = Prisma.AutomationRunGetPayload<{}>;
const TERMINAL: readonly string[] = AUTOMATION_RUN_TERMINAL_STATUSES;
const ACTIVE_RUN: readonly string[] = ['queued', 'claimed', 'running'];
const MAX_STICKIES = 256;
/** B-502: active + paused automations one account may hold; `0` disables the cap. */
const DEFAULT_MAX_AUTOMATIONS_PER_ACCOUNT = 100;

/**
 * B-502: one server-wide switch, no per-account allowlist. `VH_AUTOMATIONS_ENABLED`
 * is the only gate; the former `VH_AUTOMATIONS_ACCOUNT_IDS` is ignored, so a
 * stale value cannot hide the feature from everyone else again. Abuse is
 * bounded by the per-account cap below, not by who is allowed in.
 */
export function assertAutomationsEnabled(_accountId: string) {
    requireAutomation(process.env.VH_AUTOMATIONS_ENABLED === 'true', 'automations_disabled', 404);
}
export function maxAutomationsPerAccount(): number {
    return configuredResourceLimit('MAX_AUTOMATIONS_PER_ACCOUNT', DEFAULT_MAX_AUTOMATIONS_PER_ACCOUNT);
}
/** Counted inside the create transaction (SERIALIZABLE), so two concurrent creates cannot both squeeze under the cap. */
async function requireAutomationCapacity(tx: Tx, accountId: string): Promise<void> {
    const limit = maxAutomationsPerAccount();
    if (limit <= 0) return;
    const count = await tx.automation.count({ where: { accountId } });
    requireAutomation(count < limit, 'automation_count_quota_exceeded', 429, { limit, count });
}
const ms = (d: Date | null | undefined) => d ? d.getTime() : null;
export function toAutomationView(row: AutomationRow): Automation {
    return {
        id: row.id, name: row.name, description: row.description, machineId: row.machineId, status: row.status as Automation['status'],
        trigger: row.trigger, action: row.action, concurrency: row.concurrency as Automation['concurrency'], maxRuntimeMs: row.maxRuntimeMs,
        nextRunAt: ms(row.nextRunAt), version: row.version, lastRunAt: ms(row.lastRunAt), lastRunStatus: (row.lastRunStatus ?? null) as AutomationRunStatus | null,
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
    };
}
export function toRunView(row: RunRow, automationName: string): AutomationRun {
    return {
        id: row.id, automationId: row.automationId, automationName, machineId: row.machineId, source: row.source as AutomationRun['source'],
        dedupeKey: row.dedupeKey, payload: row.payload, status: row.status as AutomationRunStatus, needsAttention: row.needsAttention, attentionReason: row.attentionReason,
        sessionId: row.sessionId, stickyKey: row.stickyKey, scheduledFor: ms(row.scheduledFor), claimedAt: ms(row.claimedAt), leaseUntil: ms(row.leaseUntil),
        startedAt: ms(row.startedAt), finishedAt: ms(row.finishedAt), summary: row.summary, error: row.error, exitCode: row.exitCode,
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
    };
}
const stickyView = (s: { key: string; sessionId: string; updatedAt: Date }): AutomationSticky => ({ key: s.key, sessionId: s.sessionId, updatedAt: s.updatedAt.getTime() });

async function loadAutomation(tx: Tx, accountId: string, id: string): Promise<AutomationRow> {
    const row = await tx.automation.findFirst({ where: { id, accountId } });
    requireAutomation(row, 'automation_not_found', 404);
    return row;
}
async function loadAutomationByName(tx: Tx, accountId: string, name: string): Promise<AutomationRow> {
    const row = await tx.automation.findFirst({ where: { accountId, name } });
    requireAutomation(row, 'automation_not_found', 404);
    return row;
}
async function requireMachine(tx: Tx, accountId: string, machineId: string) {
    requireAutomation(await tx.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } }), 'machine_not_found', 404);
}
async function requireSession(tx: Tx, accountId: string, sessionId: string) {
    requireAutomation(await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } }), 'session_not_found', 404);
}
const defaultMaxRuntime = (action: AutomationCreate['action']) => action.kind === 'script' ? AUTOMATION_SCRIPT_DEFAULT_MAX_RUNTIME_MS : AUTOMATION_DEFAULT_MAX_RUNTIME_MS;
const uniqueViolation = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const nameTaken = uniqueViolation;
/** Serializable retries are exhausted inside `inTx`; the caller gets a retryable 409 instead of a 500. */
function mapConflict(error: unknown): never {
    if (isRetryableTransactionConflict(error)) throw new AutomationError('transaction_conflict', 409);
    throw error;
}
/** Only the newest run of an automation may set `lastRunStatus`, so late reports on older runs cannot mask a fresher outcome. */
async function setLastRunStatus(tx: Tx, automationId: string, runId: string, status: string): Promise<void> {
    const newest = await tx.automationRun.findFirst({ where: { automationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    if (newest?.id === runId) await tx.automation.update({ where: { id: automationId }, data: { lastRunStatus: status } });
}

/** Keeps the newest 200 rows per automation, every non-terminal row, and rows still holding a live dedupe slot. */
async function pruneRuns(tx: Tx, automationId: string, now: Date): Promise<void> {
    const keep = await tx.automationRun.findMany({ where: { automationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: AUTOMATION_RUN_RETENTION, select: { id: true } });
    await tx.automationRun.deleteMany({ where: {
        automationId, status: { in: [...TERMINAL] }, id: { notIn: keep.map(k => k.id) },
        NOT: { dedupeSlot: { not: null }, createdAt: { gte: new Date(now.getTime() - AUTOMATION_DEDUPE_WINDOW_MS) } },
    } });
}
/**
 * Creates one run for an automation. With `concurrency: skip`, an existing
 * queued/claimed/running run turns this occurrence into a `skipped` record.
 */
async function enqueueRun(tx: Tx, automation: AutomationRow, input: { source: AutomationRun['source']; payload?: string | null; dedupeKey?: string | null; scheduledFor?: Date | null }, now: Date): Promise<RunRow> {
    let status: AutomationRunStatus = 'queued';
    if (automation.concurrency === 'skip') {
        const busy = await tx.automationRun.findFirst({ where: { automationId: automation.id, status: { in: [...ACTIVE_RUN] } }, select: { id: true } });
        if (busy) status = 'skipped';
    }
    const run = await tx.automationRun.create({ data: {
        id: randomUUID(), automationId: automation.id, accountId: automation.accountId, machineId: automation.machineId, source: input.source,
        dedupeKey: input.dedupeKey ?? null, dedupeSlot: status === 'queued' ? input.dedupeKey ?? null : null, payload: input.payload ?? null, status, scheduledFor: input.scheduledFor ?? null,
        finishedAt: status === 'skipped' ? now : null, error: status === 'skipped' ? 'previous_run_active' : null, createdAt: now, updatedAt: now,
    } });
    await tx.automation.update({ where: { id: automation.id }, data: { lastRunAt: now, ...(status === 'skipped' ? { lastRunStatus: 'skipped' } : {}) } });
    await pruneRuns(tx, automation.id, now);
    return run;
}

/**
 * Marks leases and runtimes that ran out as `expired` (needsAttention). Runs
 * nobody claimed within ten minutes are flagged `machine_offline` once (kept
 * queued) — but only while the machine itself has not claimed for ten minutes,
 * so a healthy machine working through a queue backlog is never flagged.
 * Called inside the claim transaction and best-effort before reads.
 */
export async function sweepExpiredRuns(tx: Tx, accountId: string, now: Date): Promise<void> {
    const inFlight = await tx.automationRun.findMany({ where: { accountId, status: { in: ['claimed', 'running'] } }, include: { automation: { select: { maxRuntimeMs: true } } } });
    for (const run of inFlight) {
        const reason = run.leaseUntil && run.leaseUntil.getTime() < now.getTime() ? 'lease_expired'
            : run.claimedAt && run.claimedAt.getTime() + run.automation.maxRuntimeMs < now.getTime() ? 'max_runtime_exceeded' : null;
        if (!reason) continue;
        await tx.automationRun.update({ where: { id: run.id }, data: { status: 'expired', needsAttention: true, attentionReason: reason, finishedAt: now, updatedAt: now } });
        await setLastRunStatus(tx, run.automationId, run.id, 'expired');
    }
    const stale = new Date(now.getTime() - AUTOMATION_QUEUED_ATTENTION_MS);
    const cursors = await tx.automationClaimCursor.findMany({ where: { accountId, lastClaimAt: { gte: stale } }, select: { machineId: true } });
    await tx.automationRun.updateMany({
        where: { accountId, status: 'queued', offlineFlaggedAt: null, createdAt: { lt: stale }, machineId: { notIn: cursors.map(c => c.machineId) } },
        data: { needsAttention: true, attentionReason: 'machine_offline', offlineFlaggedAt: now, updatedAt: now },
    });
}
/** Reads must not fail or serialize on housekeeping: sweep in its own transaction and ignore conflicts. */
async function sweepBestEffort(accountId: string): Promise<void> {
    try { await inTx(tx => sweepExpiredRuns(tx, accountId, new Date())); }
    catch (error) { if (!isRetryableTransactionConflict(error)) throw error; }
}

export async function createAutomation(accountId: string, input: AutomationCreate): Promise<Automation> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    const trigger = normalizeTrigger(input.trigger, now.getTime());
    try {
        return await inTx(async tx => {
            await requireMachine(tx, accountId, input.machineId);
            await requireAutomationCapacity(tx, accountId);
            if (input.action.kind === 'send') await requireSession(tx, accountId, input.action.sessionId);
            const status = input.status ?? 'active';
            const nextRunAt = status === 'active' ? initialRunAt(trigger, now.getTime()) : null;
            const row = await tx.automation.create({ data: {
                id: randomUUID(), accountId, name: input.name, description: input.description ?? null, machineId: input.machineId, status,
                trigger, action: input.action, concurrency: input.concurrency ?? 'skip', maxRuntimeMs: input.maxRuntimeMs ?? defaultMaxRuntime(input.action),
                nextRunAt: nextRunAt === null ? null : new Date(nextRunAt), createdAt: now, updatedAt: now,
            } });
            return toAutomationView(row);
        });
    } catch (error) {
        if (nameTaken(error)) throw new AutomationError('automation_name_taken', 409);
        return mapConflict(error);
    }
}
export async function listAutomations(accountId: string, machineId?: string): Promise<Automation[]> {
    assertAutomationsEnabled(accountId);
    const rows = await db.automation.findMany({ where: { accountId, ...(machineId ? { machineId } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toAutomationView);
}
export async function getAutomation(accountId: string, id: string): Promise<Automation> {
    assertAutomationsEnabled(accountId);
    return inTx(async tx => toAutomationView(await loadAutomation(tx, accountId, id)));
}
export async function getAutomationByName(accountId: string, name: string): Promise<Automation> {
    assertAutomationsEnabled(accountId);
    return inTx(async tx => toAutomationView(await loadAutomationByName(tx, accountId, name)));
}
/** Version CAS: a stale `version` is rejected with `stale_automation`; a changed trigger recomputes nextRunAt from now. */
export async function updateAutomation(accountId: string, id: string, input: AutomationUpdate): Promise<Automation> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    try {
        return await inTx(async tx => {
            const row = await loadAutomation(tx, accountId, id);
            requireAutomation(row.version === input.version, 'stale_automation', 409, { version: row.version });
            if (input.machineId) await requireMachine(tx, accountId, input.machineId);
            const action = input.action ?? row.action;
            if (input.action?.kind === 'send') await requireSession(tx, accountId, input.action.sessionId);
            const trigger = input.trigger ? normalizeTrigger(input.trigger, now.getTime()) : row.trigger;
            const nextRunAt = input.trigger && row.status === 'active' ? initialRunAt(trigger, now.getTime()) : ms(row.nextRunAt);
            if (input.machineId && input.machineId !== row.machineId) {
                // Queued work follows the automation to its new machine; claimed/running runs stay with the machine executing them.
                await tx.automationRun.updateMany({ where: { automationId: row.id, status: 'queued' }, data: { machineId: input.machineId, updatedAt: now } });
            }
            const updated = await tx.automation.update({ where: { id: row.id }, data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
                ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
                ...(input.maxRuntimeMs !== undefined ? { maxRuntimeMs: input.maxRuntimeMs } : {}),
                trigger, action, nextRunAt: nextRunAt === null ? null : new Date(nextRunAt), version: { increment: 1 }, updatedAt: now,
            } });
            return toAutomationView(updated);
        });
    } catch (error) {
        if (nameTaken(error)) throw new AutomationError('automation_name_taken', 409);
        return mapConflict(error);
    }
}
/** Cascades runs and stickies. A daemon still executing one of its runs sees `run_not_found` on its next report and stops. */
export async function deleteAutomation(accountId: string, id: string): Promise<void> {
    assertAutomationsEnabled(accountId);
    await inTx(async tx => {
        const row = await loadAutomation(tx, accountId, id);
        await tx.automation.delete({ where: { id: row.id } });
    }).catch(mapConflict);
}
/** Pause clears nextRunAt; resume recomputes it from now (missed occurrences are not replayed). */
export async function setAutomationStatus(accountId: string, id: string, status: 'active' | 'paused'): Promise<Automation> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    return inTx(async tx => {
        const row = await loadAutomation(tx, accountId, id);
        if (row.status === status) return toAutomationView(row);
        const nextRunAt = status === 'active' ? nextRunAfter(row.trigger, now.getTime()) : null;
        const updated = await tx.automation.update({ where: { id: row.id }, data: { status, nextRunAt: nextRunAt === null ? null : new Date(nextRunAt), version: { increment: 1 }, updatedAt: now } });
        return toAutomationView(updated);
    });
}

/**
 * Event entry point. A `dedupeKey` occupies a unique per-automation slot
 * (`dedupeSlot`) for 24h: a repeat within the window returns the original run.
 * `skipped` runs never hold the slot, so an event that arrived while the
 * automation was busy is not silenced for a day. Concurrent first fires race
 * on the unique index; the loser re-reads and returns the winner's run.
 */
export async function fireAutomation(accountId: string, name: string, input: AutomationFire): Promise<AutomationFireResponse> {
    assertAutomationsEnabled(accountId);
    const attempt = () => inTx(async tx => {
        const now = new Date();
        const automation = await loadAutomationByName(tx, accountId, name);
        requireAutomation(automation.status === 'active', 'automation_paused', 409);
        if (input.dedupeKey) {
            const prior = await tx.automationRun.findUnique({ where: { automationId_dedupeSlot: { automationId: automation.id, dedupeSlot: input.dedupeKey } } });
            if (prior && prior.createdAt.getTime() >= now.getTime() - AUTOMATION_DEDUPE_WINDOW_MS) return { run: toRunView(prior, automation.name), deduplicated: true };
            if (prior) await tx.automationRun.update({ where: { id: prior.id }, data: { dedupeSlot: null } });
        }
        const run = await enqueueRun(tx, automation, { source: 'fire', payload: input.payload, dedupeKey: input.dedupeKey }, now);
        return { run: toRunView(run, automation.name), deduplicated: false };
    });
    try { return await attempt(); }
    catch (error) {
        if (!uniqueViolation(error)) return mapConflict(error);
        return attempt().catch(mapConflict);
    }
}
/** Explicit "run now"; allowed while paused because it expresses direct user intent. */
export async function runAutomationNow(accountId: string, id: string, input: AutomationManualRun): Promise<AutomationRun> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    return inTx(async tx => {
        const automation = await loadAutomation(tx, accountId, id);
        const run = await enqueueRun(tx, automation, { source: 'manual', payload: input.payload }, now);
        return toRunView(run, automation.name);
    }).catch(mapConflict);
}

export async function listRuns(accountId: string, query: { automationId?: string; name?: string; status?: string; attention?: boolean; limit?: number }): Promise<AutomationRun[]> {
    assertAutomationsEnabled(accountId);
    if (query.status !== undefined) requireAutomation((AUTOMATION_RUN_STATUSES as readonly string[]).includes(query.status), 'invalid_status', 400);
    await sweepBestEffort(accountId);
    let automationId = query.automationId;
    if (query.name) {
        const named = await db.automation.findFirst({ where: { accountId, name: query.name }, select: { id: true } });
        requireAutomation(named, 'automation_not_found', 404);
        automationId = named.id;
    }
    const rows = await db.automationRun.findMany({
        where: { accountId, ...(automationId ? { automationId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.attention ? { needsAttention: true } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit ?? 50, include: { automation: { select: { name: true } } },
    });
    return rows.map(row => toRunView(row, row.automation.name));
}
export async function getRun(accountId: string, id: string): Promise<AutomationRun> {
    assertAutomationsEnabled(accountId);
    await sweepBestEffort(accountId);
    const row = await db.automationRun.findFirst({ where: { id, accountId }, include: { automation: { select: { name: true } } } });
    requireAutomation(row, 'run_not_found', 404);
    return toRunView(row, row.automation.name);
}

async function upsertSticky(tx: Tx, automationId: string, key: string, sessionId: string, now: Date): Promise<AutomationSticky> {
    const row = await tx.automationSticky.upsert({ where: { automationId_key: { automationId, key } }, create: { automationId, key, sessionId, updatedAt: now }, update: { sessionId, updatedAt: now } });
    await tx.$executeRaw`DELETE FROM "AutomationSticky" WHERE "automationId"=${automationId} AND "key" NOT IN (SELECT "key" FROM "AutomationSticky" WHERE "automationId"=${automationId} ORDER BY "updatedAt" DESC, "key" DESC LIMIT ${MAX_STICKIES})`;
    return stickyView(row);
}
/**
 * Run report. With `claimId` (daemon): fenced, renews the lease, and may attach
 * session / sticky / attention; without `status` it is a pure renewal. Without
 * `claimId` (agent or CLI inside the session): only an explicit `done|failed`
 * with summary / error / exitCode / attention on a claimed or running run — no
 * lease, session or sticky changes. Terminal statuses never change again
 * (`run_finished` carries the current status).
 */
export async function reportRun(accountId: string, runId: string, input: AutomationReport): Promise<AutomationRun> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    return inTx(async tx => {
        const row = await tx.automationRun.findFirst({ where: { id: runId, accountId }, include: { automation: { select: { name: true } } } });
        requireAutomation(row, 'run_not_found', 404);
        requireAutomation(!TERMINAL.includes(row.status), 'run_finished', 409, { status: row.status });
        if (input.claimId === undefined) {
            // Account-level explicit outcome (agent / CLI without the daemon's claimId): terminal only, on a claimed or running run.
            requireAutomation(input.status === 'done' || input.status === 'failed', 'status_required', 400);
            requireAutomation(row.status !== 'queued', 'run_not_claimed', 409, { status: row.status });
            requireAutomation(input.leaseMs === undefined && input.stickyKey === undefined && input.sessionId === undefined, 'claim_required', 400);
        } else {
            requireAutomation(row.claimId !== null && row.claimId === input.claimId, 'claim_mismatch', 409, { status: row.status });
        }
        const data: Prisma.AutomationRunUpdateInput = { updatedAt: now };
        if (input.claimId !== undefined) data.leaseUntil = new Date(now.getTime() + (input.leaseMs ?? AUTOMATION_DEFAULT_LEASE_MS));
        if (input.sessionId) { await requireSession(tx, accountId, input.sessionId); data.sessionId = input.sessionId; }
        else if (input.sessionId === null) data.sessionId = null;
        if (input.stickyKey) {
            const sessionId = input.sessionId === undefined ? row.sessionId : input.sessionId;
            requireAutomation(sessionId, 'sticky_requires_session', 400);
            await upsertSticky(tx, row.automationId, input.stickyKey, sessionId, now);
            data.stickyKey = input.stickyKey;
        }
        if (input.needsAttention !== undefined) { data.needsAttention = input.needsAttention; data.attentionReason = input.needsAttention ? input.attentionReason ?? row.attentionReason ?? 'reported' : null; }
        else if (input.attentionReason !== undefined) data.attentionReason = input.attentionReason;
        if (input.summary !== undefined) data.summary = input.summary;
        if (input.error !== undefined) data.error = input.error;
        if (input.exitCode !== undefined) data.exitCode = input.exitCode;
        if (input.status === 'running') { data.status = 'running'; if (!row.startedAt) data.startedAt = now; }
        else if (input.status) {
            data.status = input.status; data.finishedAt = now; if (!row.startedAt) data.startedAt = now;
            await setLastRunStatus(tx, row.automationId, row.id, input.status);
        }
        const updated = await tx.automationRun.update({ where: { id: row.id }, data });
        return toRunView(updated, row.automation.name);
    }).catch(mapConflict);
}
export async function cancelRun(accountId: string, runId: string): Promise<AutomationRun> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    return inTx(async tx => {
        const row = await tx.automationRun.findFirst({ where: { id: runId, accountId }, include: { automation: { select: { name: true } } } });
        requireAutomation(row, 'run_not_found', 404);
        requireAutomation(!TERMINAL.includes(row.status), 'run_finished', 409, { status: row.status });
        const updated = await tx.automationRun.update({ where: { id: row.id }, data: { status: 'cancelled', finishedAt: now, updatedAt: now } });
        await setLastRunStatus(tx, row.automationId, row.id, 'cancelled');
        return toRunView(updated, row.automation.name);
    }).catch(mapConflict);
}
export async function ackRun(accountId: string, runId: string): Promise<AutomationRun> {
    assertAutomationsEnabled(accountId);
    return inTx(async tx => {
        const row = await tx.automationRun.findFirst({ where: { id: runId, accountId }, include: { automation: { select: { name: true } } } });
        requireAutomation(row, 'run_not_found', 404);
        const updated = await tx.automationRun.update({ where: { id: row.id }, data: { needsAttention: false, updatedAt: new Date() } });
        return toRunView(updated, row.automation.name);
    });
}

/**
 * Daemon poll. In one SERIALIZABLE transaction: record the machine's claim
 * cursor, sweep expiries, materialize due schedule runs for this machine (CAS
 * on nextRunAt; missed periods collapse into one run), then claim up to
 * `limit` runs — the oldest queued run of each automation (so a backlog on one
 * automation cannot starve the others), skipping automations that already
 * have a claimed/running run.
 */
export async function claimRuns(accountId: string, input: AutomationClaim): Promise<AutomationClaimResponse> {
    assertAutomationsEnabled(accountId);
    const now = new Date();
    const leaseMs = input.leaseMs ?? AUTOMATION_DEFAULT_LEASE_MS;
    const limit = input.limit ?? AUTOMATION_CLAIM_MAX_RUNS;
    return inTx(async tx => {
        await requireMachine(tx, accountId, input.machineId);
        await tx.automationClaimCursor.upsert({ where: { accountId_machineId: { accountId, machineId: input.machineId } }, create: { accountId, machineId: input.machineId, lastClaimAt: now }, update: { lastClaimAt: now } });
        await sweepExpiredRuns(tx, accountId, now);
        const due = await tx.automation.findMany({ where: { accountId, machineId: input.machineId, status: 'active', nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' } });
        for (const automation of due) {
            const next = nextRunAfter(automation.trigger, now.getTime());
            const advanced = await tx.automation.updateMany({ where: { id: automation.id, nextRunAt: automation.nextRunAt }, data: { nextRunAt: next === null ? null : new Date(next), updatedAt: now } });
            if (advanced.count !== 1) continue;
            await enqueueRun(tx, automation, { source: 'schedule', scheduledFor: automation.nextRunAt }, now);
        }
        const active = await tx.automationRun.findMany({ where: { accountId, status: { in: ['claimed', 'running'] } }, select: { automationId: true } });
        const busy = new Set(active.map(r => r.automationId));
        const heads = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM (
            SELECT DISTINCT ON ("automationId") "id", "createdAt" FROM "AutomationRun"
            WHERE "accountId"=${accountId} AND "machineId"=${input.machineId} AND "status"='queued'
            ORDER BY "automationId", "createdAt" ASC, "id" ASC) heads ORDER BY "createdAt" ASC, "id" ASC`;
        const queued = heads.length ? await tx.automationRun.findMany({ where: { id: { in: heads.map(h => h.id) } } }) : [];
        queued.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
        const claimed: RunRow[] = [];
        for (const run of queued) {
            if (claimed.length >= limit || busy.has(run.automationId)) continue;
            const claimId = randomUUID();
            // A machine that comes back resolves its own `machine_offline` attention.
            const attention = run.attentionReason === 'machine_offline' ? { needsAttention: false, attentionReason: null } : {};
            const patch = { status: 'claimed', claimId, claimedAt: now, leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now, ...attention };
            const updated = await tx.automationRun.updateMany({ where: { id: run.id, status: 'queued' }, data: patch });
            if (updated.count !== 1) continue;
            busy.add(run.automationId);
            claimed.push({ ...run, ...patch });
        }
        const runs: AutomationClaimResponse['runs'] = [];
        for (const run of claimed) {
            const automation = await tx.automation.findFirst({ where: { id: run.automationId } });
            if (!automation) continue;
            const stickies = await tx.automationSticky.findMany({ where: { automationId: automation.id }, orderBy: { updatedAt: 'desc' } });
            runs.push({ run: { ...toRunView(run, automation.name), claimId: run.claimId! }, automation: toAutomationView(automation), stickies: stickies.map(stickyView) });
        }
        return { runs, leaseMs };
    }).catch(mapConflict);
}

export async function listStickies(accountId: string, automationId: string, key?: string): Promise<AutomationSticky[]> {
    assertAutomationsEnabled(accountId);
    return inTx(async tx => {
        await loadAutomation(tx, accountId, automationId);
        const rows = await tx.automationSticky.findMany({ where: { automationId, ...(key ? { key } : {}) }, orderBy: { updatedAt: 'desc' } });
        return rows.map(stickyView);
    });
}
export async function putSticky(accountId: string, automationId: string, key: string, sessionId: string): Promise<AutomationSticky> {
    assertAutomationsEnabled(accountId);
    return inTx(async tx => {
        await loadAutomation(tx, accountId, automationId);
        await requireSession(tx, accountId, sessionId);
        return upsertSticky(tx, automationId, key, sessionId, new Date());
    });
}
export async function deleteSticky(accountId: string, automationId: string, key: string): Promise<boolean> {
    assertAutomationsEnabled(accountId);
    return inTx(async tx => {
        await loadAutomation(tx, accountId, automationId);
        const removed = await tx.automationSticky.deleteMany({ where: { automationId, key } });
        return removed.count > 0;
    });
}
export { isAutomationRunTerminal };
