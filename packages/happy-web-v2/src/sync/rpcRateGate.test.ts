import { describe, expect, it, vi } from 'vitest';
import {
    isRpcRateLimitAck,
    MAX_RETRIES,
    RATE_RETRY_MAX_DELAY_MS,
    RATE_RETRY_MIN_DELAY_MS,
    RATE_WAIT_CAP_MS,
    rateWindowMs,

    rpcDedupKey,
    RpcRateGate,
    RpcRateLimitedError,
} from './rpcRateGate';

/** Deterministic clock + sleep that advances the clock (no real timers). */
function harness(onLimited = vi.fn()) {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const gate = new RpcRateGate({
            now: () => now,
            random: () => 0,
            sleep: async (ms) => { sleeps.push(ms); now += ms; },
            onLimited,
        });
    return { gate, sleeps, onLimited, clock: { get now() { return now; }, advance(ms: number) { now += ms; } } };
}

const limited = (retryAfterMs?: number, error = 'RPC rate limit reached') =>
({ ok: false as const, error, ...(retryAfterMs !== undefined ? { code: 'rpc_rate_limited', retryAfterMs } : {}) });

describe('isRpcRateLimitAck', () => {
        it('recognises both server strings and both codes, nothing else', () => {
                expect(isRpcRateLimitAck({ ok: false, error: 'RPC rate limit reached' })).toBe(true);
                expect(isRpcRateLimitAck({ ok: false, error: 'RPC account rate limit reached' })).toBe(true);
                expect(isRpcRateLimitAck({ ok: false, error: 'x', code: 'rpc_rate_limited' })).toBe(true);
                expect(isRpcRateLimitAck({ ok: false, error: 'x', code: 'rpc_account_rate_limited' })).toBe(true);
                expect(isRpcRateLimitAck({ ok: false, error: 'RPC method not available' })).toBe(false);
                expect(isRpcRateLimitAck({ ok: true, result: 'RPC rate limit reached' })).toBe(false);
                expect(isRpcRateLimitAck(null)).toBe(false);
                expect(isRpcRateLimitAck('RPC rate limit reached')).toBe(false);
            });
    });

describe('rateWindowMs', () => {
        it('follows the server hint with 1.0–1.5× jitter, capped', () => {
                expect(rateWindowMs(1, 4_000, 0)).toBe(4_000);
                expect(rateWindowMs(1, 4_000, 0.999)).toBeLessThan(6_000);
                expect(rateWindowMs(1, 4_000, 0.999)).toBeGreaterThan(5_900);
                expect(rateWindowMs(1, 10 * 60_000, 0.5)).toBe(RATE_WAIT_CAP_MS);
            });

        it('falls back to a 2s→60s exponential ladder with full jitter when the server said nothing', () => {
                expect(rateWindowMs(1, undefined, 0)).toBe(RATE_RETRY_MIN_DELAY_MS);
                expect(rateWindowMs(1, undefined, 0.999)).toBeLessThanOrEqual(RATE_RETRY_MIN_DELAY_MS);
                expect(rateWindowMs(2, undefined, 0.999)).toBeLessThanOrEqual(4_000);
                expect(rateWindowMs(3, undefined, 1 - 1e-9)).toBe(8_000);
                expect(rateWindowMs(10, undefined, 1 - 1e-9)).toBe(RATE_RETRY_MAX_DELAY_MS);
                expect(rateWindowMs(99, undefined, 1 - 1e-9)).toBe(RATE_RETRY_MAX_DELAY_MS);
                // Never below the minimum: a 3ms "wait" would not leave the bucket alone.
                expect(rateWindowMs(5, undefined, 0)).toBe(RATE_RETRY_MIN_DELAY_MS);
                // Zero / NaN hints are treated as absent, not as "retry now".
                expect(rateWindowMs(1, 0, 0)).toBe(RATE_RETRY_MIN_DELAY_MS);
                expect(rateWindowMs(1, Number.NaN, 0)).toBe(RATE_RETRY_MIN_DELAY_MS);
            });
    });

describe('rpcDedupKey', () => {
        it('is stable for equal params and distinct across route/method/params', () => {
                expect(rpcDedupKey('control', 's1:bash', { command: 'git status', cwd: '/a' }))
                    .toBe(rpcDedupKey('control', 's1:bash', { command: 'git status', cwd: '/a' }));
                expect(rpcDedupKey('control', 's1:bash', { command: 'git status' }))
                    .not.toBe(rpcDedupKey('relay:m1', 's1:bash', { command: 'git status' }));
                expect(rpcDedupKey('control', 's1:bash', { command: 'git status' }))
                    .not.toBe(rpcDedupKey('control', 's1:abort', { command: 'git status' }));
                expect(rpcDedupKey('control', 's1:bash', { command: 'git status' }))
                    .not.toBe(rpcDedupKey('control', 's1:bash', { command: 'git diff' }));
                // Unserialisable params must not throw (BigInt / cycles).
                const cyclic: any = {}; cyclic.self = cyclic;
                expect(() => rpcDedupKey('control', 'm', cyclic)).not.toThrow();
            });
    });

describe('RpcRateGate', () => {
        it('passes an open route straight through and does not announce', async () => {
                const { gate, sleeps, onLimited } = harness();
                const fn = vi.fn(async () => ({ ok: true, result: 'r' }));
                await expect(gate.run('control', 'k1', fn)).resolves.toEqual({ ok: true, result: 'r' });
                expect(fn).toHaveBeenCalledTimes(1);
                expect(sleeps).toEqual([]);
                expect(onLimited).not.toHaveBeenCalled();
            });

        it('on a refusal with retryAfterMs: waits exactly that (jitter 0), retries once, announces once', async () => {
                const { gate, sleeps, onLimited } = harness();
                const fn = vi.fn()
                    .mockResolvedValueOnce(limited(3_000))
                    .mockResolvedValueOnce({ ok: true, result: 'later' });
                await expect(gate.run('control', 'k', fn)).resolves.toEqual({ ok: true, result: 'later' });
                expect(fn).toHaveBeenCalledTimes(2);
                expect(sleeps).toEqual([3_000]);
                expect(onLimited).toHaveBeenCalledTimes(1);
                expect(onLimited.mock.calls[0][0]).toMatchObject({ route: 'control', waitMs: 3_000, attempt: 1, serverError: 'RPC rate limit reached' });
                // Success reopened the route fully.
                expect(gate.waitFor('control')).toBe(0);
                expect(gate.isRecovering('control')).toBe(false);
            });

        it('without a server hint falls back to the exponential ladder', async () => {
                const { gate, sleeps } = harness();
                const fn = vi.fn()
                    .mockResolvedValueOnce(limited())
                    .mockResolvedValueOnce(limited())
                    .mockResolvedValueOnce({ ok: true });
                await gate.run('control', 'k', fn);
                // random=0 → minimum each time (the ladder's ceiling only matters with jitter).
                expect(sleeps).toEqual([RATE_RETRY_MIN_DELAY_MS, RATE_RETRY_MIN_DELAY_MS]);
            });

        it(`gives up after ${MAX_RETRIES} retries with an RpcRateLimitedError carrying the server string`, async () => {
                const { gate } = harness();
                const fn = vi.fn(async () => limited(1_000, 'RPC account rate limit reached'));
                const error = await gate.run('relay:m1', 'k', fn).catch((e) => e);
                expect(error).toBeInstanceOf(RpcRateLimitedError);
                expect(error.message).toBe('RPC account rate limit reached');
                expect(error.route).toBe('relay:m1');
                expect(fn).toHaveBeenCalledTimes(MAX_RETRIES + 1);
            });

        it('holds concurrent calls at the gate while a route is closed and releases them paced', async () => {
        // Manual sleep: promises resolve only when the test says so, so the
        // window is observable while it is open.
        let now = 1_000_000;
        const pending: Array<{ ms: number; resolve: () => void }> = [];
        const gate = new RpcRateGate({
            now: () => now,
            random: () => 0,
            sleep: (ms) => new Promise<void>((resolve) => { pending.push({ ms, resolve }); }),
        });
        const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
        const wake = async () => { const p = pending.shift()!; now += p.ms; p.resolve(); await flush(); };

        const trip = vi.fn().mockResolvedValueOnce(limited(2_000)).mockResolvedValueOnce({ ok: true, n: 0 });
        const p0 = gate.run('control', 'k0', trip);
        await flush();
        // The refusal closed the route; the first call is asleep for the window.
        expect(gate.waitFor('control')).toBe(2_000);
        expect(pending.map((p) => p.ms)).toEqual([2_000]);

        const sent: number[] = [];
        const others = [1, 2, 3].map((n) => gate.run('control', `k${n}`, async () => { sent.push(now); return { ok: true, n }; }));
        await flush();
        // All three joined the wait; none was emitted.
        expect(sent).toEqual([]);
        expect(pending.map((p) => p.ms)).toEqual([2_000, 2_000, 2_000, 2_000]);

        // Window elapses for everyone.
        while (pending.length && pending[0].ms === 2_000) await wake();
        // The route is recovering: the retry of k0 goes first, the rest are
        // released one per RECOVERY_SPACING_MS — the first success ends recovery,
        // so at most a couple of spacing sleeps are needed, never a burst.
        let guard = 0;
        while (pending.length && guard++ < 10) await wake();
        await Promise.all([p0, ...others]);
        expect(trip).toHaveBeenCalledTimes(2);
        expect(sent).toHaveLength(3);
        for (const at of sent) expect(at).toBeGreaterThanOrEqual(1_000_000 + 2_000);
        expect(gate.isRecovering('control')).toBe(false);
        expect(gate.waitFor('control')).toBe(0);
    });

    it('collapses identical waiting calls onto one emit', async () => {
                const { gate } = harness();
                const fn = vi.fn(async () => ({ ok: true, result: 'once' }));
                const key = rpcDedupKey('control', 's1:bash', { command: 'git status' });
                const [a, b, c] = await Promise.all([
                        gate.run('control', key, fn),
                        gate.run('control', key, fn),
                        gate.run('control', key, fn),
                    ]);
                expect(fn).toHaveBeenCalledTimes(1);
                expect(a).toBe(b);
                expect(b).toBe(c);
                // After settling, the same key runs again (not cached forever).
                await gate.run('control', key, fn);
                expect(fn).toHaveBeenCalledTimes(2);
            });

        it('routes are independent: a closed relay does not hold the control socket', async () => {
                const { gate, sleeps } = harness();
                await gate.run('relay:m1', 'a', vi.fn().mockResolvedValueOnce(limited(5_000)).mockResolvedValueOnce({ ok: true }));
                expect(sleeps).toEqual([5_000]);
                const fn = vi.fn(async () => ({ ok: true }));
                await gate.run('control', 'b', fn);
                expect(sleeps).toEqual([5_000]); // no extra wait
                expect(fn).toHaveBeenCalledTimes(1);
            });

        it('a second refusal inside an open window extends it silently (one toast per incident)', async () => {
                const { gate, onLimited } = harness();
                gate.noteLimited('control', limited(4_000));
                gate.noteLimited('control', limited(4_000));
                gate.noteLimited('control', limited(4_000));
                expect(onLimited).toHaveBeenCalledTimes(1);
                expect(gate.waitFor('control')).toBe(4_000);
            });

        it('never waits longer than the cap even if the server asks for more', async () => {
                const { gate, sleeps } = harness();
                await gate.run('control', 'k', vi.fn().mockResolvedValueOnce(limited(30 * 60_000)).mockResolvedValueOnce({ ok: true }));
                expect(sleeps).toEqual([RATE_WAIT_CAP_MS]);
            });

        it('does not interpret non-rate failures: they pass through untouched and reopen the route', async () => {
                const { gate, sleeps } = harness();
                const fn = vi.fn(async () => ({ ok: false, error: 'RPC method not available' }));
                await expect(gate.run('control', 'k', fn)).resolves.toEqual({ ok: false, error: 'RPC method not available' });
                expect(fn).toHaveBeenCalledTimes(1);
                expect(sleeps).toEqual([]);
                const thrower = vi.fn(async () => { throw new Error('operation has timed out'); });
                await expect(gate.run('control', 'k2', thrower)).rejects.toThrow('operation has timed out');
                expect(thrower).toHaveBeenCalledTimes(1);
            });
    });
