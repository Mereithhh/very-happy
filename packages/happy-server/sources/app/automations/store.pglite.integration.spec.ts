import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type * as Store from './store';

describe('automations store (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/automations-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let store: typeof Store; let accountId: string; let otherAccountId: string; let machineId: string; let sessionId: string;
    let counter = 0;
    const spawn = { kind: 'spawn' as const, agent: 'claude', directory: '/repo', prompt: 'do {{payload}}' };
    const make = (overrides: Partial<Parameters<typeof Store.createAutomation>[1]> = {}) => store.createAutomation(accountId, { name: `auto-${++counter}`, machineId, trigger: { kind: 'manual' }, action: spawn, ...overrides });
    const setNextRunAt = (id: string, at: Date | null) => db.automation.update({ where: { id }, data: { nextRunAt: at } });
    beforeAll(async () => {
        process.env.VH_AUTOMATIONS_ENABLED = 'true';
        delete process.env.VH_AUTOMATIONS_ACCOUNT_IDS;
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'automations-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        store = await import('./store');
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'metadata' } });
        sessionId = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });

    it('is disabled by default; B-502: the switch is server-wide and a leftover account allowlist is ignored', async () => {
        delete process.env.VH_AUTOMATIONS_ENABLED;
        await expect(store.listAutomations(accountId)).rejects.toMatchObject({ code: 'automations_disabled', status: 404 });
        process.env.VH_AUTOMATIONS_ENABLED = 'true'; process.env.VH_AUTOMATIONS_ACCOUNT_IDS = 'someone-else';
        expect(await store.listAutomations(accountId)).toEqual([]);
        delete process.env.VH_AUTOMATIONS_ACCOUNT_IDS;
    });

    it('B-502: caps active + paused automations per account with a 429 the clients can name', async () => {
        const previous = process.env.MAX_AUTOMATIONS_PER_ACCOUNT;
        process.env.MAX_AUTOMATIONS_PER_ACCOUNT = '2';
        try {
            const capped = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
            const cappedMachine = crypto.randomUUID();
            await db.machine.create({ data: { id: cappedMachine, accountId: capped, metadata: 'metadata' } });
            const create = (name: string, status?: 'active' | 'paused') => store.createAutomation(capped, { name, machineId: cappedMachine, trigger: { kind: 'manual' }, action: spawn, ...(status ? { status } : {}) });
            await create('cap-1');
            const paused = await create('cap-2', 'paused');
            await expect(create('cap-3')).rejects.toMatchObject({ code: 'automation_count_quota_exceeded', status: 429, details: { limit: 2, count: 2 } });
            // Paused rows count; deleting one frees a slot; pause/resume never changes the count.
            await store.deleteAutomation(capped, paused.id);
            const third = await create('cap-3');
            await store.setAutomationStatus(capped, third.id, 'paused');
            await store.setAutomationStatus(capped, third.id, 'active');
            await expect(create('cap-4')).rejects.toMatchObject({ code: 'automation_count_quota_exceeded', status: 429 });
            // Other accounts are unaffected; `0` disables the cap.
            await make();
            process.env.MAX_AUTOMATIONS_PER_ACCOUNT = '0';
            await create('cap-4');
        } finally {
            if (previous === undefined) delete process.env.MAX_AUTOMATIONS_PER_ACCOUNT; else process.env.MAX_AUTOMATIONS_PER_ACCOUNT = previous;
        }
    });

    it('creates with computed nextRunAt, enforces unique names, machine ownership and account isolation', async () => {
        const before = Date.now();
        const a = await make({ name: 'daily', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, description: 'd' });
        expect(a).toMatchObject({ name: 'daily', status: 'active', concurrency: 'skip', maxRuntimeMs: 6 * 3_600_000, version: 1, lastRunAt: null });
        expect(a.nextRunAt!).toBeGreaterThan(before);
        expect(new Date(a.nextRunAt!).toISOString()).toMatch(/T01:00:00\.000Z$/);
        const script = await make({ action: { kind: 'script', command: ['echo', 'hi'] }, trigger: { kind: 'interval', everyMs: 300_000 } });
        expect(script.maxRuntimeMs).toBe(30 * 60_000);
        expect(script.trigger).toMatchObject({ kind: 'interval', everyMs: 300_000 });
        expect((script.trigger as { anchorAt?: number }).anchorAt).toBeGreaterThan(before - 1);
        await expect(make({ name: 'daily' })).rejects.toMatchObject({ code: 'automation_name_taken', status: 409 });
        await expect(make({ machineId: 'nope' })).rejects.toMatchObject({ code: 'machine_not_found', status: 404 });
        await expect(make({ trigger: { kind: 'cron', expr: 'bad', tz: 'UTC' } })).rejects.toMatchObject({ code: 'invalid_cron', status: 400 });
        await expect(make({ action: { kind: 'send', sessionId: 'missing', prompt: 'p' } })).rejects.toMatchObject({ code: 'session_not_found', status: 404 });
        expect((await store.getAutomationByName(accountId, 'daily')).id).toBe(a.id);
        await expect(store.getAutomation(otherAccountId, a.id)).rejects.toMatchObject({ code: 'automation_not_found', status: 404 });
        await expect(store.getAutomationByName(otherAccountId, 'daily')).rejects.toMatchObject({ code: 'automation_not_found' });
        expect(await store.listAutomations(otherAccountId)).toEqual([]);
        await expect(store.fireAutomation(otherAccountId, 'daily', {})).rejects.toMatchObject({ code: 'automation_not_found' });
    });

    it('updates with version CAS and recomputes nextRunAt when the trigger changes', async () => {
        const a = await make({ trigger: { kind: 'manual' } });
        expect(a.nextRunAt).toBeNull();
        await expect(store.updateAutomation(accountId, a.id, { version: 99, description: 'x' })).rejects.toMatchObject({ code: 'stale_automation', details: { version: 1 } });
        const updated = await store.updateAutomation(accountId, a.id, { version: 1, trigger: { kind: 'interval', everyMs: 60_000 }, concurrency: 'queue' });
        expect(updated.version).toBe(2); expect(updated.concurrency).toBe('queue'); expect(updated.nextRunAt).toBeGreaterThan(Date.now());
        const paused = await store.setAutomationStatus(accountId, a.id, 'paused');
        expect(paused).toMatchObject({ status: 'paused', nextRunAt: null, version: 3 });
        const resumed = await store.setAutomationStatus(accountId, a.id, 'active');
        expect(resumed.status).toBe('active'); expect(resumed.nextRunAt).toBeGreaterThan(Date.now());
        const moveTo = crypto.randomUUID();
        await db.machine.create({ data: { id: moveTo, accountId, metadata: 'metadata' } });
        const queuedRun = await store.runAutomationNow(accountId, a.id, {});
        const claimedRun = await store.claimRuns(accountId, { machineId });
        expect(claimedRun.runs.some(r => r.run.id === queuedRun.id)).toBe(true);
        const following = await store.runAutomationNow(accountId, a.id, {});
        const moved = await store.updateAutomation(accountId, a.id, { version: 4, machineId: moveTo });
        expect(moved.machineId).toBe(moveTo);
        expect((await store.getRun(accountId, following.id)).machineId).toBe(moveTo);
        expect((await store.getRun(accountId, queuedRun.id)).machineId).toBe(machineId);
        // The in-flight run still occupies the automation; once it finishes the moved queue is claimable on the new machine.
        expect((await store.claimRuns(accountId, { machineId: moveTo })).runs.some(r => r.run.id === following.id)).toBe(false);
        await store.reportRun(accountId, queuedRun.id, { claimId: claimedRun.runs.find(r => r.run.id === queuedRun.id)!.run.claimId, status: 'done' });
        expect((await store.claimRuns(accountId, { machineId: moveTo })).runs.some(r => r.run.id === following.id)).toBe(true);
        await store.deleteAutomation(accountId, a.id);
        await expect(store.getAutomation(accountId, a.id)).rejects.toMatchObject({ code: 'automation_not_found' });
        await expect(store.reportRun(accountId, following.id, { claimId: 'x' })).rejects.toMatchObject({ code: 'run_not_found', status: 404 });
    });

    it('retries a serialization failure on the first transaction attempt and maps exhaustion to 409', async () => {
        const { Prisma } = await import('@prisma/client');
        const conflict = () => new Prisma.PrismaClientKnownRequestError('could not serialize access', { code: 'P2034', clientVersion: 'test' });
        const original = db.$transaction.bind(db);
        const spy = vi.spyOn(db, '$transaction');
        spy.mockImplementationOnce(async () => { throw conflict(); });
        spy.mockImplementation(original as any);
        const a = await make();
        expect(spy).toHaveBeenCalledTimes(2);
        expect((await store.getAutomation(accountId, a.id)).id).toBe(a.id);
        spy.mockReset(); spy.mockImplementation(async () => { throw conflict(); });
        await expect(store.runAutomationNow(accountId, a.id, {})).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
        expect(spy).toHaveBeenCalledTimes(4);
        // Prisma's client is a Proxy: restoring the spy drops the method, so hand the original back explicitly.
        spy.mockImplementation(original as any);
    });

    it('lets only the newest run set lastRunStatus and honours an explicit null sessionId', async () => {
        const a = await make({ concurrency: 'queue' });
        const older = await store.runAutomationNow(accountId, a.id, {});
        const olderClaim = (await store.claimRuns(accountId, { machineId })).runs.find(r => r.run.id === older.id)!;
        const newer = await store.runAutomationNow(accountId, a.id, {});
        await store.reportRun(accountId, older.id, { claimId: olderClaim.run.claimId, status: 'done' });
        expect((await store.getAutomation(accountId, a.id)).lastRunStatus).toBeNull();
        const newerClaim = (await store.claimRuns(accountId, { machineId })).runs.find(r => r.run.id === newer.id)!;
        await store.reportRun(accountId, newer.id, { claimId: newerClaim.run.claimId, status: 'running', sessionId });
        await expect(store.reportRun(accountId, newer.id, { claimId: newerClaim.run.claimId, sessionId: null, stickyKey: 'k' })).rejects.toMatchObject({ code: 'sticky_requires_session' });
        const detached = await store.reportRun(accountId, newer.id, { claimId: newerClaim.run.claimId, sessionId: null, status: 'failed' });
        expect(detached.sessionId).toBeNull();
        expect((await store.getAutomation(accountId, a.id)).lastRunStatus).toBe('failed');
    });

    it('fires with payload, deduplicates by key for 24h and refuses paused automations', async () => {
        const a = await make({ name: 'events', concurrency: 'queue' });
        const first = await store.fireAutomation(accountId, 'events', { payload: '{"conversationId":"c1"}', dedupeKey: 'evt-1' });
        expect(first.deduplicated).toBe(false);
        expect(first.run).toMatchObject({ status: 'queued', source: 'fire', payload: '{"conversationId":"c1"}', dedupeKey: 'evt-1', automationName: 'events', machineId });
        const [dupA, dupB] = await Promise.all([store.fireAutomation(accountId, 'events', { dedupeKey: 'evt-1' }), store.fireAutomation(accountId, 'events', { dedupeKey: 'evt-1' })]);
        expect(dupA.run.id).toBe(first.run.id); expect(dupB.run.id).toBe(first.run.id); expect(dupA.deduplicated && dupB.deduplicated).toBe(true);
        const other = await store.fireAutomation(accountId, 'events', { dedupeKey: 'evt-2' });
        expect(other.run.id).not.toBe(first.run.id);
        await db.automationRun.update({ where: { id: first.run.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
        const reopened = await store.fireAutomation(accountId, 'events', { dedupeKey: 'evt-1' });
        expect(reopened.deduplicated).toBe(false); expect(reopened.run.id).not.toBe(first.run.id);
        expect((await db.automationRun.findUnique({ where: { id: first.run.id } }))!.dedupeSlot).toBeNull();
        expect((await store.listRuns(accountId, { name: 'events' })).length).toBe(3);
        // Many concurrent first fires with one key converge on a single run (unique slot + re-read).
        const burst = await Promise.all(Array.from({ length: 6 }, () => store.fireAutomation(accountId, 'events', { dedupeKey: 'burst' })));
        expect(new Set(burst.map(b => b.run.id)).size).toBe(1);
        expect(burst.filter(b => !b.deduplicated)).toHaveLength(1);
        expect((await store.getAutomation(accountId, a.id)).lastRunAt).not.toBeNull();
        await store.setAutomationStatus(accountId, a.id, 'paused');
        await expect(store.fireAutomation(accountId, 'events', {})).rejects.toMatchObject({ code: 'automation_paused', status: 409 });
        expect((await store.runAutomationNow(accountId, a.id, { payload: 'manual' })).source).toBe('manual');
    });

    it('records skipped runs while a previous run is still active under concurrency=skip', async () => {
        const a = await make();
        const first = await store.runAutomationNow(accountId, a.id, {});
        const second = await store.runAutomationNow(accountId, a.id, {});
        expect(first.status).toBe('queued');
        expect(second).toMatchObject({ status: 'skipped', error: 'previous_run_active' });
        expect(second.finishedAt).not.toBeNull();
        expect((await store.getAutomation(accountId, a.id)).lastRunStatus).toBe('skipped');
        // A skipped run does not hold the dedupe slot, so the same event is not silenced for 24h.
        const busy = await make({ name: 'busy-events' });
        await store.runAutomationNow(accountId, busy.id, {});
        const skippedFire = await store.fireAutomation(accountId, 'busy-events', { dedupeKey: 'evt' });
        expect(skippedFire.run.status).toBe('skipped'); expect(skippedFire.deduplicated).toBe(false);
        const again = await store.fireAutomation(accountId, 'busy-events', { dedupeKey: 'evt' });
        expect(again.deduplicated).toBe(false); expect(again.run.id).not.toBe(skippedFire.run.id);
    });

    it('materializes one run for many missed periods and never double-claims under concurrent claims', async () => {
        const a = await make({ name: 'cron-claim', trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' } });
        await setNextRunAt(a.id, new Date(Date.now() - 3 * 3_600_000));
        const results = await Promise.all([store.claimRuns(accountId, { machineId }), store.claimRuns(accountId, { machineId })]);
        const claimed = results.flatMap(r => r.runs).filter(r => r.automation.id === a.id);
        expect(claimed).toHaveLength(1);
        expect(claimed[0].run).toMatchObject({ status: 'claimed', source: 'schedule', automationName: 'cron-claim' });
        expect(claimed[0].run.claimId).toMatch(/[0-9a-f-]{36}/);
        expect(claimed[0].run.leaseUntil!).toBeGreaterThan(Date.now());
        expect(claimed[0].automation.action).toEqual(spawn);
        const runs = await store.listRuns(accountId, { automationId: a.id });
        expect(runs).toHaveLength(1);
        expect(runs[0].scheduledFor).toBeLessThan(Date.now() - 3 * 3_600_000 + 1000);
        expect((runs[0] as { claimId?: string }).claimId).toBeUndefined();
        const after = await store.getAutomation(accountId, a.id);
        expect(after.nextRunAt!).toBeGreaterThan(Date.now());
        expect(after.nextRunAt! - Date.now()).toBeLessThanOrEqual(5 * 60_000);
        // The next claim finds nothing due and nothing queued for this automation.
        expect((await store.claimRuns(accountId, { machineId })).runs.filter(r => r.automation.id === a.id)).toHaveLength(0);
        // A once trigger fires once and then has no next run.
        const once = await make({ trigger: { kind: 'once', at: Date.now() - 60_000 } });
        expect(once.nextRunAt).toBe((once.trigger as { at: number }).at);
        expect((await store.claimRuns(accountId, { machineId })).runs.some(r => r.automation.id === once.id)).toBe(true);
        expect((await store.getAutomation(accountId, once.id))).toMatchObject({ status: 'active', nextRunAt: null });
    });

    it('claims at most one run per automation and only for the requesting machine', async () => {
        const a = await make({ concurrency: 'queue' });
        for (let i = 0; i < 3; i++) await store.runAutomationNow(accountId, a.id, { payload: `p${i}` });
        const otherMachine = crypto.randomUUID();
        await db.machine.create({ data: { id: otherMachine, accountId, metadata: 'metadata' } });
        const b = await make({ machineId: otherMachine, concurrency: 'queue' });
        await store.runAutomationNow(accountId, b.id, {});
        // A deep backlog on `a` must not starve a newer automation on the same machine.
        const late = await make({ concurrency: 'queue' });
        for (let i = 0; i < 40; i++) await store.runAutomationNow(accountId, a.id, { payload: `extra${i}` });
        await store.runAutomationNow(accountId, late.id, { payload: 'late' });
        const first = await store.claimRuns(accountId, { machineId });
        expect(first.runs.filter(r => r.automation.id === a.id).map(r => r.run.payload)).toEqual(['p0']);
        expect(first.runs.filter(r => r.automation.id === late.id).map(r => r.run.payload)).toEqual(['late']);
        expect(first.runs.some(r => r.automation.id === b.id)).toBe(false);
        expect((await store.claimRuns(accountId, { machineId })).runs.filter(r => r.automation.id === a.id)).toHaveLength(0);
        await store.reportRun(accountId, first.runs.find(r => r.automation.id === a.id)!.run.id, { claimId: first.runs.find(r => r.automation.id === a.id)!.run.claimId, status: 'done' });
        expect((await store.claimRuns(accountId, { machineId })).runs.filter(r => r.automation.id === a.id).map(r => r.run.payload)).toEqual(['p1']);
        expect((await store.claimRuns(accountId, { machineId: otherMachine })).runs.map(r => r.automation.id)).toEqual([b.id]);
        await expect(store.claimRuns(accountId, { machineId: 'ghost' })).rejects.toMatchObject({ code: 'machine_not_found', status: 404 });
        await expect(store.claimRuns(otherAccountId, { machineId })).rejects.toMatchObject({ code: 'machine_not_found' });
    });

    it('fences reports by claimId, renews leases, and never reverts a terminal status', async () => {
        const a = await make();
        const queued = await store.runAutomationNow(accountId, a.id, {});
        await expect(store.reportRun(accountId, queued.id, { claimId: 'anything', status: 'running' })).rejects.toMatchObject({ code: 'claim_mismatch', status: 409, details: { status: 'queued' } });
        const { runs } = await store.claimRuns(accountId, { machineId, leaseMs: 30_000 });
        const claimed = runs.find(r => r.run.id === queued.id)!;
        await expect(store.reportRun(accountId, queued.id, { claimId: 'stale', status: 'running' })).rejects.toMatchObject({ code: 'claim_mismatch' });
        await expect(store.reportRun(otherAccountId, queued.id, { claimId: claimed.run.claimId })).rejects.toMatchObject({ code: 'run_not_found', status: 404 });
        const renewed = await store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, leaseMs: 120_000 });
        expect(renewed.status).toBe('claimed'); expect(renewed.leaseUntil!).toBeGreaterThan(claimed.run.leaseUntil! + 60_000);
        const running = await store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, status: 'running', sessionId, stickyKey: 'conv-1' });
        expect(running).toMatchObject({ status: 'running', sessionId, stickyKey: 'conv-1' }); expect(running.startedAt).not.toBeNull();
        expect(await store.listStickies(accountId, a.id, 'conv-1')).toMatchObject([{ key: 'conv-1', sessionId }]);
        await expect(store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, sessionId: 'not-mine' })).rejects.toMatchObject({ code: 'session_not_found' });
        const done = await store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, status: 'done', summary: 'ok', exitCode: 0 });
        expect(done).toMatchObject({ status: 'done', summary: 'ok', exitCode: 0 }); expect(done.finishedAt).not.toBeNull();
        await expect(store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, status: 'failed' })).rejects.toMatchObject({ code: 'run_finished', status: 409, details: { status: 'done' } });
        await expect(store.cancelRun(accountId, queued.id)).rejects.toMatchObject({ code: 'run_finished' });
        expect((await store.getRun(accountId, queued.id)).status).toBe('done');
        expect((await store.getAutomation(accountId, a.id)).lastRunStatus).toBe('done');
        const cancelled = await store.cancelRun(accountId, (await store.runAutomationNow(accountId, a.id, {})).id);
        expect(cancelled.status).toBe('cancelled');
        const third = await store.runAutomationNow(accountId, a.id, {});
        const thirdClaim = (await store.claimRuns(accountId, { machineId })).runs.find(x => x.run.id === third.id)!;
        const attention = await store.reportRun(accountId, third.id, { claimId: thirdClaim.run.claimId, status: 'failed', error: 'boom', needsAttention: true, attentionReason: 'unknown_result' });
        expect(attention).toMatchObject({ status: 'failed', error: 'boom', needsAttention: true, attentionReason: 'unknown_result' });
        expect((await store.listRuns(accountId, { attention: true })).some(r => r.id === attention.id)).toBe(true);
        expect((await store.ackRun(accountId, attention.id)).needsAttention).toBe(false);
        await expect(store.listRuns(accountId, { status: 'bogus' })).rejects.toMatchObject({ code: 'invalid_status', status: 400 });
    });

    it('accepts account-level terminal reports without a claimId under conservative rules', async () => {
        const a = await make({ concurrency: 'queue' });
        const queued = await store.runAutomationNow(accountId, a.id, {});
        await expect(store.reportRun(accountId, queued.id, { status: 'done' })).rejects.toMatchObject({ code: 'run_not_claimed', status: 409, details: { status: 'queued' } });
        const { runs } = await store.claimRuns(accountId, { machineId, leaseMs: 30_000 });
        const claimed = runs.find(r => r.run.id === queued.id)!;
        await expect(store.reportRun(accountId, queued.id, { summary: 'no status' })).rejects.toMatchObject({ code: 'status_required', status: 400 });
        await expect(store.reportRun(accountId, queued.id, { status: 'running' })).rejects.toMatchObject({ code: 'status_required' });
        await expect(store.reportRun(accountId, queued.id, { status: 'done', leaseMs: 60_000 })).rejects.toMatchObject({ code: 'claim_required', status: 400 });
        await expect(store.reportRun(accountId, queued.id, { status: 'done', stickyKey: 'k' })).rejects.toMatchObject({ code: 'claim_required' });
        await expect(store.reportRun(accountId, queued.id, { status: 'done', sessionId })).rejects.toMatchObject({ code: 'claim_required' });
        await expect(store.reportRun(otherAccountId, queued.id, { status: 'done' })).rejects.toMatchObject({ code: 'run_not_found' });
        const running = await store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, status: 'running', sessionId });
        const done = await store.reportRun(accountId, queued.id, { status: 'done', summary: 'agent said so', exitCode: 0, needsAttention: true, attentionReason: 'review' });
        expect(done).toMatchObject({ status: 'done', summary: 'agent said so', exitCode: 0, needsAttention: true, attentionReason: 'review', sessionId, leaseUntil: running.leaseUntil });
        expect(done.finishedAt).not.toBeNull();
        // The daemon's later fenced report cannot reopen or override the terminal state.
        await expect(store.reportRun(accountId, queued.id, { claimId: claimed.run.claimId, status: 'failed' })).rejects.toMatchObject({ code: 'run_finished', details: { status: 'done' } });
        await expect(store.reportRun(accountId, queued.id, { status: 'failed' })).rejects.toMatchObject({ code: 'run_finished' });
        expect((await store.getAutomation(accountId, a.id)).lastRunStatus).toBe('done');
    });

    it('expires stale leases and overlong runs, and flags unclaimed runs after ten minutes', async () => {
        const a = await make({ maxRuntimeMs: 60_000 });
        const lease = await store.runAutomationNow(accountId, a.id, {});
        const { runs } = await store.claimRuns(accountId, { machineId });
        const claimId = runs.find(r => r.run.id === lease.id)!.run.claimId;
        await db.automationRun.update({ where: { id: lease.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
        const expired = await store.getRun(accountId, lease.id);
        expect(expired).toMatchObject({ status: 'expired', needsAttention: true, attentionReason: 'lease_expired' });
        await expect(store.reportRun(accountId, lease.id, { claimId, status: 'done' })).rejects.toMatchObject({ code: 'run_finished', details: { status: 'expired' } });
        expect((await store.getAutomation(accountId, a.id)).lastRunStatus).toBe('expired');
        const long = await store.runAutomationNow(accountId, a.id, {});
        const claimedLong = (await store.claimRuns(accountId, { machineId })).runs.find(r => r.run.id === long.id)!;
        await store.reportRun(accountId, long.id, { claimId: claimedLong.run.claimId, status: 'running', leaseMs: 3_600_000 });
        await db.automationRun.update({ where: { id: long.id }, data: { claimedAt: new Date(Date.now() - 61_000) } });
        expect((await store.claimRuns(accountId, { machineId })).runs.some(r => r.run.id === long.id)).toBe(false);
        expect(await store.getRun(accountId, long.id)).toMatchObject({ status: 'expired', attentionReason: 'max_runtime_exceeded' });
        // Queue backlog on a machine that keeps claiming is never `machine_offline`.
        const backlog = await make({ concurrency: 'queue' });
        await store.runAutomationNow(accountId, backlog.id, {});
        const waiting = await store.runAutomationNow(accountId, backlog.id, {});
        await store.claimRuns(accountId, { machineId });
        await db.automationRun.update({ where: { id: waiting.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
        expect(await store.getRun(accountId, waiting.id)).toMatchObject({ status: 'queued', needsAttention: false });
        // The machine stops claiming: the stale queued run is flagged once, ack sticks, and a returning machine clears it.
        await db.automationClaimCursor.update({ where: { accountId_machineId: { accountId, machineId } }, data: { lastClaimAt: new Date(Date.now() - 11 * 60_000) } });
        expect(await store.getRun(accountId, waiting.id)).toMatchObject({ status: 'queued', needsAttention: true, attentionReason: 'machine_offline' });
        expect((await store.ackRun(accountId, waiting.id)).needsAttention).toBe(false);
        expect(await store.getRun(accountId, waiting.id)).toMatchObject({ needsAttention: false, attentionReason: 'machine_offline' });
        const offline = await store.runAutomationNow(accountId, a.id, {});
        await db.automationRun.update({ where: { id: offline.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
        expect(await store.getRun(accountId, offline.id)).toMatchObject({ status: 'queued', needsAttention: true, attentionReason: 'machine_offline' });
        const back = (await store.claimRuns(accountId, { machineId })).runs.find(r => r.run.id === offline.id)!;
        expect(back.run).toMatchObject({ status: 'claimed', needsAttention: false, attentionReason: null });
        expect(await store.getRun(accountId, offline.id)).toMatchObject({ needsAttention: false, attentionReason: null });
        // A never-seen machine counts as offline.
        const fresh = crypto.randomUUID();
        await db.machine.create({ data: { id: fresh, accountId, metadata: 'metadata' } });
        const never = await make({ machineId: fresh });
        const orphan = await store.runAutomationNow(accountId, never.id, {});
        await db.automationRun.update({ where: { id: orphan.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
        expect(await store.getRun(accountId, orphan.id)).toMatchObject({ needsAttention: true, attentionReason: 'machine_offline' });
    });

    it('manages stickies per automation and returns them with claims', async () => {
        const a = await make({ action: { ...spawn, sticky: { key: '{{payload.conversationId}}' } } });
        await expect(store.putSticky(accountId, a.id, 'c1', 'ghost')).rejects.toMatchObject({ code: 'session_not_found' });
        expect(await store.putSticky(accountId, a.id, 'c1', sessionId)).toMatchObject({ key: 'c1', sessionId });
        await expect(store.putSticky(otherAccountId, a.id, 'c1', sessionId)).rejects.toMatchObject({ code: 'automation_not_found' });
        await store.runAutomationNow(accountId, a.id, {});
        const { runs } = await store.claimRuns(accountId, { machineId });
        expect(runs.find(r => r.automation.id === a.id)!.stickies).toMatchObject([{ key: 'c1', sessionId }]);
        expect(await store.deleteSticky(accountId, a.id, 'c1')).toBe(true);
        expect(await store.deleteSticky(accountId, a.id, 'c1')).toBe(false);
        expect(await store.listStickies(accountId, a.id)).toEqual([]);
    });

    it('keeps the newest 200 runs plus every non-terminal run', async () => {
        const a = await make({ concurrency: 'queue' });
        const base = Date.now() - 10_000_000;
        await db.automationRun.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ id: `${a.id}-${i}`, automationId: a.id, accountId, machineId, source: 'manual', status: i === 0 ? 'queued' : 'done', createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000) })) });
        await store.runAutomationNow(accountId, a.id, {});
        const remaining = await db.automationRun.findMany({ where: { automationId: a.id }, orderBy: { createdAt: 'asc' } });
        expect(remaining).toHaveLength(201);
        expect(remaining[0]).toMatchObject({ id: `${a.id}-0`, status: 'queued' });
        expect(remaining.some(r => r.id === `${a.id}-1`)).toBe(false);
        expect(remaining.some(r => r.id === `${a.id}-6`)).toBe(true);
        // A terminal row still holding a 24h dedupe slot is retained beyond the 200 newest.
        await db.automationRun.create({ data: { id: `${a.id}-slot`, automationId: a.id, accountId, machineId, source: 'fire', status: 'done', dedupeKey: 'keep', dedupeSlot: 'keep', createdAt: new Date(base - 1000), updatedAt: new Date(base - 1000) } });
        await store.runAutomationNow(accountId, a.id, {});
        expect(await db.automationRun.findUnique({ where: { id: `${a.id}-slot` } })).not.toBeNull();
    });

    it('serves the REST surface with gate 404, error bodies and run views', async () => {
        const { default: fastify } = await import('fastify');
        const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
        const { automationRoutes } = await import('@/app/api/routes/automationRoutes');
        const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        let userId = accountId;
        app.decorate('authenticate', async (request: any) => { request.userId = userId; }); automationRoutes(app as any);
        const created = await app.inject({ method: 'POST', url: '/v1/automations', payload: { name: 'rest', machineId, trigger: { kind: 'interval', everyMs: 60_000 }, action: spawn } });
        expect(created.statusCode).toBe(200);
        const automation = created.json().automation;
        expect(automation).toMatchObject({ name: 'rest', status: 'active' });
        expect((await app.inject({ method: 'POST', url: '/v1/automations', payload: { name: 'Bad Name', machineId, trigger: { kind: 'manual' }, action: spawn } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'PATCH', url: `/v1/automations/${automation.id}`, payload: { version: 5, description: 'x' } })).json()).toEqual({ error: 'stale_automation', version: 1 });
        const fired = await app.inject({ method: 'POST', url: '/v1/automations/by-name/rest/fire', payload: { payload: 'hello', dedupeKey: 'k' } });
        expect(fired.json()).toMatchObject({ deduplicated: false, run: { status: 'queued', payload: 'hello' } });
        const claim = await app.inject({ method: 'POST', url: '/v1/automations/claim', payload: { machineId } });
        const mine = claim.json().runs.find((r: any) => r.automation.id === automation.id);
        expect(mine).toMatchObject({ run: { id: fired.json().run.id, status: 'claimed' }, automation: { name: 'rest' }, stickies: [] });
        expect(typeof mine.run.claimId).toBe('string');
        expect((await app.inject({ method: 'POST', url: `/v1/automations/runs/${mine.run.id}/report`, payload: { summary: 'no status' } })).json()).toEqual({ error: 'status_required' });
        const done = await app.inject({ method: 'POST', url: `/v1/automations/runs/${mine.run.id}/report`, payload: { claimId: mine.run.claimId, status: 'done', summary: 's' } });
        expect(done.json().run).toMatchObject({ status: 'done', summary: 's' });
        expect((await app.inject({ method: 'POST', url: `/v1/automations/runs/${mine.run.id}/cancel` })).json()).toEqual({ error: 'run_finished', status: 'done' });
        const runs = await app.inject({ method: 'GET', url: `/v1/automations/runs?name=rest&status=done&limit=5` });
        expect(runs.json().runs.map((r: any) => r.id)).toEqual([mine.run.id]);
        expect(runs.json().runs[0].claimId).toBeUndefined();
        expect((await app.inject({ method: 'PUT', url: `/v1/automations/${automation.id}/stickies`, payload: { key: 'k1', sessionId } })).json().sticky).toMatchObject({ key: 'k1', sessionId });
        expect((await app.inject({ method: 'GET', url: `/v1/automations/${automation.id}/stickies?key=k1` })).json().stickies).toHaveLength(1);
        expect((await app.inject({ method: 'DELETE', url: `/v1/automations/${automation.id}/stickies`, payload: { key: 'k1' } })).json()).toEqual({ removed: true });
        expect((await app.inject({ method: 'GET', url: `/v1/automations/by-name/rest` })).json().automation.id).toBe(automation.id);
        userId = otherAccountId;
        expect((await app.inject({ method: 'GET', url: `/v1/automations/${automation.id}` })).statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: `/v1/automations/runs/${mine.run.id}` })).statusCode).toBe(404);
        userId = accountId;
        expect((await app.inject({ method: 'POST', url: `/v1/automations/${automation.id}/pause` })).json().automation.status).toBe('paused');
        expect((await app.inject({ method: 'DELETE', url: `/v1/automations/${automation.id}` })).json()).toEqual({ ok: true });
        delete process.env.VH_AUTOMATIONS_ENABLED;
        const gated = await app.inject({ method: 'GET', url: '/v1/automations' });
        expect(gated.statusCode).toBe(404); expect(gated.json()).toEqual({ error: 'automations_disabled' });
        expect((await app.inject({ method: 'POST', url: '/v1/automations/claim', payload: { machineId } })).statusCode).toBe(404);
        process.env.VH_AUTOMATIONS_ENABLED = 'true';
        await app.close();
    });
});
