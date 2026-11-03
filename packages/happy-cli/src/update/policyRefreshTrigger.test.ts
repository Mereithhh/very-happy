import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CliUpdateState } from '@/api/types';
import { createUpdateController } from './updateController';
import {
    createPolicyRefreshTrigger, createWakeDetector, POLICY_REFRESH_MIN_INTERVAL_MS, POLICY_REFRESH_RETRY_MS,
    type PolicyRefreshResult,
} from './policyRefreshTrigger';

function harness(results: PolicyRefreshResult[] = []) {
    let clock = 10_000_000;
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const refresh = vi.fn(async (): Promise<PolicyRefreshResult> => results.shift() ?? 'ok');
    const trigger = createPolicyRefreshTrigger({
        refresh,
        now: () => clock,
        setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
        clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const live = () => timers.filter((t) => !t.cleared);
    const fire = async () => { const t = live().pop()!; t.cleared = true; t.fn(); await settle(); };
    return { trigger, refresh, live, fire, settle, advance: (ms: number) => { clock += ms; } };
}

describe('policy refresh trigger (B-876)', () => {
    it('a reconnect long after the last check re-reads the policy at once', async () => {
        const h = harness();
        expect(h.trigger.request('connect')).toBe('run');
        await h.settle();
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(h.live()).toHaveLength(0);
    });

    it('paces a reconnect storm to one refresh per 5 minutes — and still runs the one asked for inside the window', async () => {
        const h = harness();
        h.trigger.request('startup');
        await h.settle();
        h.advance(60_000);
        for (let i = 0; i < 20; i += 1) expect(h.trigger.request('connect')).toBe('deferred');
        expect(h.refresh).toHaveBeenCalledTimes(1);
        // one trailing run, at the end of the window (a promote made right after the last check is not lost)
        expect(h.live().map((t) => t.ms)).toEqual([POLICY_REFRESH_MIN_INTERVAL_MS - 60_000]);
        h.advance(POLICY_REFRESH_MIN_INTERVAL_MS - 60_000);
        await h.fire();
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.live()).toHaveLength(0);
    });

    it('the hourly / announcement refresh restarts the window', async () => {
        const h = harness();
        h.trigger.noteRefreshed('ok');
        expect(h.trigger.request('connect')).toBe('deferred');
        h.trigger.noteRefreshed('unavailable');
        expect(h.refresh).not.toHaveBeenCalled();
    });

    it('a failed fetch (network not back yet after wake) is retried 30 s later, not an hour later', async () => {
        const h = harness(['unavailable', 'ok']);
        h.trigger.request('wake');
        await h.settle();
        expect(h.live().map((t) => t.ms)).toEqual([POLICY_REFRESH_RETRY_MS]);
        h.advance(POLICY_REFRESH_RETRY_MS);
        await h.fire();
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.live()).toHaveLength(0);
    });

    it('a reconnect right after a failed wake-time fetch runs at once — the network is back', async () => {
        const h = harness(['unavailable', 'ok']);
        h.trigger.request('wake');
        await h.settle();
        h.advance(5_000);
        expect(h.trigger.request('stale')).toBe('deferred');
        expect(h.trigger.request('connect')).toBe('run');
        await h.settle();
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.live()).toHaveLength(0);
    });

    it('a refresh skipped because another update operation held the fence is retried', async () => {
        const h = harness(['busy', 'ok']);
        h.trigger.request('connect');
        await h.settle();
        h.advance(POLICY_REFRESH_RETRY_MS);
        await h.fire();
        expect(h.refresh).toHaveBeenCalledTimes(2);
    });

    it('never stacks a second refresh on one in flight, and stop() cancels the trailing run', async () => {
        const h = harness();
        h.trigger.request('connect');
        expect(h.trigger.request('connect')).toBe('in-flight');
        await h.settle();
        h.advance(1_000);
        h.trigger.request('connect');
        expect(h.live()).toHaveLength(1);
        h.trigger.stop();
        expect(h.live()).toHaveLength(0);
        expect(h.trigger.request('connect')).toBe('stopped');
        expect(h.refresh).toHaveBeenCalledTimes(1);
    });
});

describe('wake detector (B-876)', () => {
    it('a heartbeat whose wall-clock gap is far past its interval ran right after a suspend', () => {
        let clock = 0;
        const d = createWakeDetector(60_000, () => clock);
        expect(d.beat()).toBe(false);
        clock += 60_000; expect(d.beat()).toBe(false);
        clock += 90_000; expect(d.beat()).toBe(false); // a slow heartbeat is not a wake
        clock += 65 * 60_000; expect(d.beat()).toBe(true); // slept (monotonic timers paused, Date.now did not)
        clock += 60_000; expect(d.beat()).toBe(false);
    });
});

describe('controller + trigger: Release38 / Release40 (B-876)', () => {
    const base: CliUpdateState = { currentVersion: '0.2.200', recommendedVersion: '0.2.200', minimumVersion: null, autoUpdateVersion: '0.2.200', checkedAt: 0, status: 'current' };

    function machine(idle: boolean) {
        let clock = 0;
        let served: CliUpdateState = { ...base, checkedAt: 0 };
        const published: string[] = [];
        const install = vi.fn(async () => 0);
        const controller = createUpdateController({
            policy: vi.fn(async () => ({ ...served, checkedAt: clock })),
            enabled: async () => true,
            idle: () => idle,
            install,
            publish: (s) => { if (s.autoUpdate) published.push(s.autoUpdate.state); },
            now: () => clock,
        });
        const trigger = createPolicyRefreshTrigger({ refresh: () => controller.refresh(), now: () => clock, setTimer: () => null, clearTimer: () => undefined });
        return {
            controller, trigger, published, install,
            promote: (v: string) => { served = { ...base, recommendedVersion: v, autoUpdateVersion: v, status: 'available' }; },
            advance: (ms: number) => { clock += ms; },
        };
    }

    it('slept through the promote: the stale heartbeat used to only say policy_stale; now it fetches and waits for idle', async () => {
        const m = machine(false);
        await m.controller.refresh();
        expect(m.published.at(-1)).toBe('current');
        m.promote('0.2.201'); // announcement sent while asleep — never seen
        m.advance(66 * 60_000); // DarkWake: the held policy is past 65 min
        await m.controller.tick();
        expect(m.published.at(-1)).toBe('policy_stale'); // the old dead end
        expect(m.controller.policyStale()).toBe(true);
        expect(m.trigger.request('stale')).toBe('run');
        await new Promise((r) => setTimeout(r, 0));
        expect(m.published.at(-1)).toBe('waiting_idle');
        expect(m.controller.currentTarget()).toBe('0.2.201');
    });

    it('reconnect with a fresh-looking policy: an idle machine installs right away', async () => {
        const m = machine(true);
        await m.controller.refresh();
        m.promote('0.2.201');
        m.advance(20 * 60_000); // asleep 20 min, policy not yet stale — tick changes nothing
        await m.controller.tick();
        expect(m.install).not.toHaveBeenCalled();
        m.trigger.request('connect');
        await new Promise((r) => setTimeout(r, 0));
        expect(m.install).toHaveBeenCalledWith('0.2.201');
        expect(m.published.at(-1)).toBe('installed');
    });
});

// Wiring — verified with scripts/dev/mutation-check.mjs (see PR).
const run = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8');
const apiMachine = readFileSync(join(__dirname, '..', 'api', 'apiMachine.ts'), 'utf8');

describe('B-876 wiring', () => {
    it('every control-socket connect asks for a refresh', () => {
        expect(run).toContain("apiMachine.setControlConnectedHandler(() => { policyRefresh.request('connect'); });");
        const activate = apiMachine.slice(apiMachine.indexOf('private activateControlSocket('));
        expect(activate.slice(0, 600)).toContain('this.controlConnectedHandler?.();');
    });
    it('the heartbeat fetches after a wake or with a stale policy — only once it knows it still owns the machine (B-864)', () => {
        const fetchAt = run.indexOf("if (woke || updateController.policyStale()) policyRefresh.request(woke ? 'wake' : 'stale');");
        const supersededReturn = run.indexOf("// B-864: and stop here");
        expect(fetchAt).toBeGreaterThan(-1);
        expect(supersededReturn).toBeGreaterThan(-1);
        expect(fetchAt).toBeGreaterThan(supersededReturn);
    });
    it('the startup check goes through the trigger and both stop paths stop it', () => {
        expect(run).toContain("policyRefresh.request('startup');");
        expect(run.match(/policyRefresh\.stop\(\);/g)).toHaveLength(2);
    });
});
