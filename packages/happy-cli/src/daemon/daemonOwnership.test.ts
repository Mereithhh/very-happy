import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CliUpdateState } from '@/api/types';
import { createUpdateController } from '@/update/updateController';
import { createPolicyRefreshTrigger, POLICY_REFRESH_MIN_INTERVAL_MS, type PolicyRefreshReason } from '@/update/policyRefreshTrigger';
import { createDaemonOwnership } from './daemonOwnership';

describe('daemon ownership (B-876b)', () => {
    it('owned while the state file names us or is missing; superseded latches and exits once', () => {
        let statePid: number | null = 42;
        const onSuperseded = vi.fn();
        const o = createDaemonOwnership({ pid: 42, statePid: () => statePid, onSuperseded });
        expect(o.owns()).toBe(true);
        statePid = null;
        expect(o.owns()).toBe(true);
        statePid = 1;
        expect(o.owns()).toBe(false);
        statePid = 42; // our own publish must not be able to win it back
        expect(o.owns()).toBe(false);
        expect(onSuperseded).toHaveBeenCalledTimes(1);
        expect(onSuperseded).toHaveBeenCalledWith(1);
    });
});

// QA48 supersede2: statefile pid → 1, clock +6 min (past the pacing window, not stale), then an entry fires.
describe('a superseded daemon fetches, installs and publishes nothing — on every entry (B-876b)', () => {
    const base: CliUpdateState = { currentVersion: '0.2.200', recommendedVersion: '0.2.200', minimumVersion: null, autoUpdateVersion: '0.2.200', checkedAt: 0, status: 'current' };

    function machine() {
        let clock = 0;
        let statePid = 42;
        let served: CliUpdateState = base;
        const published: string[] = [];
        const install = vi.fn(async () => 0);
        const policy = vi.fn(async () => ({ ...served, checkedAt: clock }));
        const onSuperseded = vi.fn();
        const timers: Array<() => void> = [];
        const ownership = createDaemonOwnership({ pid: 42, statePid: () => statePid, onSuperseded });
        const controller = createUpdateController({
            policy, enabled: async () => true, idle: () => true, install,
            owned: ownership.owns,
            publish: (s) => { if (ownership.owns() && s.autoUpdate) published.push(s.autoUpdate.state); },
            now: () => clock,
        });
        const trigger = createPolicyRefreshTrigger({
            refresh: () => controller.refresh(), now: () => clock,
            setTimer: (fn) => { timers.push(fn); return fn; },
            clearTimer: (fn) => { const i = timers.indexOf(fn as () => void); if (i >= 0) timers.splice(i, 1); },
        });
        return {
            controller, trigger, published, install, policy, onSuperseded, timers,
            supersede: () => { statePid = 1; },
            promote: (v: string) => { served = { ...base, recommendedVersion: v, autoUpdateVersion: v, status: 'available' }; },
            advance: (ms: number) => { clock += ms; },
        };
    }
    const settle = () => new Promise((r) => setTimeout(r, 0));

    async function started() {
        const m = machine();
        expect(m.trigger.request('startup')).toBe('run');
        await settle();
        expect(m.policy).toHaveBeenCalledTimes(1);
        expect(m.published).toEqual(['current']);
        m.promote('0.2.201');
        m.supersede();
        return m;
    }

    function expectNothingDone(m: Awaited<ReturnType<typeof started>>) {
        expect(m.policy).toHaveBeenCalledTimes(1); // the startup read only
        expect(m.install).not.toHaveBeenCalled();
        expect(m.published).toEqual(['current']);
        expect(m.onSuperseded).toHaveBeenCalledTimes(1); // B-864 self-exit
        expect(m.timers).toHaveLength(0); // no retry, no trailing run
        expect(m.trigger.request('connect')).toBe('stopped');
    }

    it.each<PolicyRefreshReason>(['connect', 'wake', 'stale'])('%s', async (reason) => {
        const m = await started();
        m.advance(reason === 'stale' ? 66 * 60_000 : POLICY_REFRESH_MIN_INTERVAL_MS + 60_000);
        expect(m.trigger.request(reason)).toBe('run');
        await settle();
        expectNothingDone(m);
    });

    it('scheduled (the run at the end of the pacing window)', async () => {
        const m = await started();
        m.advance(60_000);
        expect(m.trigger.request('connect')).toBe('deferred');
        expect(m.timers).toHaveLength(1);
        m.advance(POLICY_REFRESH_MIN_INTERVAL_MS);
        m.timers.shift()!();
        await settle();
        expectNothingDone(m);
    });

    it('hourly / announcement refresh, heartbeat tick, retry and manual request', async () => {
        const m = await started();
        m.advance(POLICY_REFRESH_MIN_INTERVAL_MS + 60_000);
        const result = await m.controller.refresh();
        expect(result).toBe('superseded');
        m.trigger.noteRefreshed(result);
        await m.controller.tick();
        expect(await m.controller.retry('0.2.201')).toEqual({ error: 'daemon_superseded' });
        expect(await m.controller.request('0.2.201')).toEqual({ error: 'daemon_superseded' });
        expectNothingDone(m);
    });

    it('control: the same sequence on a daemon that still owns the machine fetches and installs', async () => {
        const m = machine();
        m.trigger.request('startup');
        await settle();
        m.promote('0.2.201');
        m.advance(POLICY_REFRESH_MIN_INTERVAL_MS + 60_000);
        expect(m.trigger.request('connect')).toBe('run');
        await settle();
        expect(m.policy).toHaveBeenCalledTimes(2);
        expect(m.install).toHaveBeenCalledWith('0.2.201');
        expect(m.onSuperseded).not.toHaveBeenCalled();
    });
});

// Wiring — verified with scripts/dev/mutation-check.mjs (see PR).
const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');

describe('B-876b wiring', () => {
    it('the update controller asks daemonOwnership before every fetch / install (connect, scheduled, wake, stale, hourly)', () => {
        expect(run).toContain('owned: daemonOwnership.owns,');
        expect(run).toContain('refresh: () => updateController.refresh(),');
        expect(run).toContain('statePid: readDaemonStatePidSync,');
    });
    it('publish never writes the state file once superseded', () => {
        const publish = run.slice(run.indexOf('owned: daemonOwnership.owns,'));
        expect(publish).toMatch(/^owned: daemonOwnership\.owns,\s*publish: \(state\) => \{\s*\/\/[^\n]*\n\s*if \(!daemonOwnership\.owns\(\)\) return;\s*cliUpdateStateRef = state;/);
    });
    it('superseded requests the B-864 shutdown; the heartbeat checks before tick/handover and before its write', () => {
        expect(run).toMatch(/onSuperseded: \(ownerPid\) => \{\s*logger\.debug\([^\n]*\n\s*requestShutdown\('exception', 'A different daemon was started without killing us\. We should kill ourselves\.'\);/);
        const beat = run.slice(run.indexOf('const restartOnStaleVersionAndHeartbeat'));
        const guards = [...beat.matchAll(/if \(!daemonOwnership\.owns\(\)\) return;/g)].map((m) => m.index!);
        expect(guards.length).toBeGreaterThanOrEqual(2);
        expect(guards[0]).toBeLessThan(beat.indexOf('await updateController.tick();'));
        const write = beat.indexOf('fileState = withDaemonHeartbeat(');
        expect(guards[1]).toBeLessThan(write);
        expect(guards[1]).toBeGreaterThan(beat.indexOf('await updateController.withHandover('));
    });
});
