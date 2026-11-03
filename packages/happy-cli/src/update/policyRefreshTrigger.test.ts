import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CliUpdateState } from '@/api/types';
import { createUpdateController } from './updateController';
import {
    createPolicyRefreshTrigger, createWakeDetector, POLICY_REFRESH_MAX_BACKOFF_MS, POLICY_REFRESH_MIN_INTERVAL_MS, POLICY_REFRESH_RETRY_MS,
    type PolicyRefreshReason, type PolicyRefreshResult,
} from './policyRefreshTrigger';

function harness(results: PolicyRefreshResult[] = [], fallback: PolicyRefreshResult = 'ok') {
    let clock = 10_000_000;
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const logs: Array<[string, 'warn' | 'debug']> = [];
    const refresh = vi.fn(async (): Promise<PolicyRefreshResult> => results.shift() ?? fallback);
    const trigger = createPolicyRefreshTrigger({
        refresh,
        now: () => clock,
        log: (message, level) => { logs.push([message, level]); },
        setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
        clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const live = () => timers.filter((t) => !t.cleared);
    const fire = async () => { const t = live().pop()!; t.cleared = true; t.fn(); await settle(); };
    /** Fires the pending timer after waiting it out, and returns its delay. */
    const waitOut = async () => { const ms = live().at(-1)!.ms; clock += ms; await fire(); return ms; };
    return { trigger, refresh, logs, live, fire, waitOut, settle, advance: (ms: number) => { clock += ms; } };
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

describe('policy refresh backoff (B-876c)', () => {
    it('a fetch that keeps failing backs off 30 s → 1 m → 2 m … and stays at 30 m; a success resets it', async () => {
        const h = harness([], 'unavailable');
        h.trigger.request('startup');
        await h.settle();
        const delays: number[] = [];
        for (let i = 0; i < 9; i += 1) delays.push(await h.waitOut());
        expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, POLICY_REFRESH_MAX_BACKOFF_MS, POLICY_REFRESH_MAX_BACKOFF_MS, POLICY_REFRESH_MAX_BACKOFF_MS]);
        h.refresh.mockResolvedValueOnce('ok');
        await h.waitOut();
        expect(h.live()).toHaveLength(0);
        h.refresh.mockResolvedValueOnce('unavailable');
        h.advance(POLICY_REFRESH_MIN_INTERVAL_MS);
        h.trigger.request('stale');
        await h.settle();
        expect(h.live().map((t) => t.ms)).toEqual([POLICY_REFRESH_RETRY_MS]);
    });

    it('warns on the first failure and on each step up, not on every capped retry', async () => {
        const h = harness([], 'unavailable');
        h.trigger.request('startup');
        await h.settle();
        for (let i = 0; i < 9; i += 1) await h.waitOut();
        const warns = h.logs.filter(([, level]) => level === 'warn').map(([m]) => m);
        // the startup line, then one per step: 30 s, 1, 2, 4, 8, 16, 30 m
        expect(warns).toHaveLength(8);
        expect(warns[0]).toBe('CLI update policy refresh (startup)');
        expect(warns.at(-1)).toContain('next try in 1800s');
        expect(h.logs.slice(-4).map(([, level]) => level)).toEqual(['debug', 'debug', 'debug', 'debug']);
        h.refresh.mockResolvedValueOnce('ok');
        await h.waitOut();
        expect(h.logs.at(-1)).toEqual(['CLI update policy refresh recovered after 10 failed attempt(s)', 'warn']);
    });

    it('stale requests wait out the backoff; a connect or wake skips it, at most once per 5 minutes', async () => {
        const h = harness([], 'unavailable');
        h.trigger.request('startup');
        await h.settle();
        await h.waitOut(); await h.waitOut(); await h.waitOut(); // backoff now 4 min
        h.advance(10_000);
        expect(h.trigger.request('stale')).toBe('deferred');
        expect(h.trigger.request('connect')).toBe('run');
        await h.settle();
        h.advance(10_000);
        expect(h.trigger.request('connect')).toBe('deferred');
        expect(h.trigger.request('wake')).toBe('deferred');
        h.advance(POLICY_REFRESH_MIN_INTERVAL_MS);
        expect(h.trigger.request('wake')).toBe('run');
        expect(h.refresh).toHaveBeenCalledTimes(6);
    });

    it('blocked (manual recovery) schedules nothing; stale requests wait out the backoff, the next connect asks again', async () => {
        const h = harness([], 'blocked');
        h.trigger.request('startup');
        await h.settle();
        expect(h.live()).toHaveLength(0);
        expect(h.logs.at(-1)).toEqual(['CLI update policy refresh (startup) read no fresh policy (blocked, 1 in a row); waiting for the next connect / wake / hourly check', 'warn']);
        h.advance(60_000);
        expect(h.trigger.request('stale')).toBe('run'); // past the 30 s backoff
        await h.settle();
        expect(h.live()).toHaveLength(0);
        h.advance(30_000);
        expect(h.trigger.request('stale')).toBe('deferred'); // 1 m backoff not over yet
        h.live().forEach((t) => { t.cleared = true; });
        expect(h.trigger.request('connect')).toBe('run');
        await h.settle();
        expect(h.refresh).toHaveBeenCalledTimes(3);
    });

    it('an hourly check that read a fresh policy ends the backoff; one that read a stale policy still restarts the window', async () => {
        const h = harness([], 'unavailable');
        h.trigger.request('startup');
        await h.settle();
        await h.waitOut(); await h.waitOut(); await h.waitOut(); // backoff now 4 min
        h.live().forEach((t) => { t.cleared = true; });
        h.trigger.noteRefreshed('ok');
        h.advance(POLICY_REFRESH_MIN_INTERVAL_MS);
        expect(h.trigger.request('stale')).toBe('run');
        await h.settle();
        expect(h.live().map((t) => t.ms)).toEqual([POLICY_REFRESH_RETRY_MS]);

        const s = harness();
        s.trigger.noteRefreshed('stale');
        expect(s.trigger.request('connect')).toBe('deferred');
    });

    it('a policy the server already reports as stale backs off from the 5-minute window instead of re-fetching every window', async () => {
        const h = harness([], 'stale');
        h.trigger.request('startup');
        await h.settle();
        const delays: number[] = [];
        for (let i = 0; i < 7; i += 1) delays.push(await h.waitOut());
        expect(delays).toEqual([300_000, 300_000, 300_000, 300_000, 480_000, 960_000, POLICY_REFRESH_MAX_BACKOFF_MS]);
        h.trigger.noteRefreshed('stale'); // an hourly check that read the same stale policy does not reset it
        h.advance(POLICY_REFRESH_MIN_INTERVAL_MS);
        h.refresh.mockResolvedValueOnce('stale');
        expect(h.trigger.request('stale')).toBe('deferred');
    });
});

describe('controller + trigger + heartbeat: one hour of failing fetches, simulated clock (B-876c)', () => {
    const fresh: CliUpdateState = { currentVersion: '0.2.200', recommendedVersion: '0.2.200', minimumVersion: null, autoUpdateVersion: '0.2.200', checkedAt: 0, status: 'current' };

    /** run.ts in miniature: startup + connect, the 60 s heartbeat (wake / stale), the hourly check. */
    async function hour(served: () => CliUpdateState | null, maxBackoffMs?: number) {
        vi.useFakeTimers({ now: 1_800_000_000_000 });
        try {
            const policy = vi.fn(async () => served());
            const controller = createUpdateController({ policy, enabled: async () => true, idle: () => true, install: async () => 0, publish: () => undefined });
            const warns: string[] = [];
            const trigger = createPolicyRefreshTrigger({ refresh: () => controller.refresh(), maxBackoffMs, log: (m, level) => { if (level === 'warn') warns.push(m); } });
            const request = (reason: PolicyRefreshReason) => trigger.request(reason);
            request('startup');
            setTimeout(() => request('connect'), 1_000);
            const wake = createWakeDetector(60_000);
            setInterval(() => { const woke = wake.beat(); if (woke || controller.policyStale()) request(woke ? 'wake' : 'stale'); }, 60_000);
            setInterval(() => { void controller.refresh().then(trigger.noteRefreshed); }, 60 * 60_000);
            await vi.advanceTimersByTimeAsync(60 * 60_000);
            trigger.stop();
            return { fetches: policy.mock.calls.length, warns: warns.length };
        } finally { vi.clearAllTimers(); vi.useRealTimers(); }
    }

    it('the policy endpoint fails for an hour: single-digit fetches and warnings (fixed 30 s retry was ~120)', async () => {
        const r = await hour(() => null);
        expect(r.fetches).toBeLessThan(10);
        expect(r.warns).toBeLessThan(10);
        // without the backoff (cap = 30 s) the same hour is the QA48 storm
        expect((await hour(() => null, POLICY_REFRESH_RETRY_MS)).fetches).toBeGreaterThan(100);
    });

    it('the server keeps returning a 70-minute-old checkedAt: single-digit fetches (every 5-minute window was 13)', async () => {
        const r = await hour(() => ({ ...fresh, checkedAt: Date.now() - 70 * 60_000 }));
        expect(r.fetches).toBeLessThan(10);
    });

    it('a healthy hour: startup, the trailing run for the connect inside its window, hourly', async () => {
        expect((await hour(() => ({ ...fresh, checkedAt: Date.now() }))).fetches).toBe(3);
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
    it('retries that are not news log at debug, not warn (B-876c)', () => {
        expect(run).toContain("log: (message, level) => level === 'warn' ? logger.warn(`[DAEMON RUN] ${message}`) : logger.debug(`[DAEMON RUN] ${message}`),");
    });
    it('the startup check goes through the trigger and both stop paths stop it', () => {
        expect(run).toContain("policyRefresh.request('startup');");
        expect(run.match(/policyRefresh\.stop\(\);/g)).toHaveLength(2);
    });
});
