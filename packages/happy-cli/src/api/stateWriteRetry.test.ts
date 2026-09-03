/**
 * B-307 — the client half of the rate-limit self-lock.
 *
 * The production shape: `session_state` sat at its ceiling for an hour on an
 * account whose steady-state use is under 1% of it, because every writer
 * retried within a second and never gave up. These tests pin the two things
 * that stop that: the refusal is recognised at all, and the wait it produces
 * is on the bucket's minute-long timescale rather than the packet-loss one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    RATE_RETRY_MAX_DELAY_MS,
    RATE_RETRY_MIN_DELAY_MS,
    isRateQuotaCode,
    pauseForRateQuota,
    rateRetryDelayMs,
} from './stateWriteRetry';

describe('isRateQuotaCode', () => {
    it('recognises every account-resource rate refusal the server can send', () => {
        for (const code of [
            'session_state_rate_quota_exceeded',
            'machine_state_rate_quota_exceeded',
            'message_rate_quota_exceeded',
            'artifact_rate_quota_exceeded',
        ]) {
            expect(isRateQuotaCode(code)).toBe(true);
        }
    });

    it('does NOT treat a size or count refusal as a reason to wait a minute', () => {
        // These never clear on their own — waiting is the wrong response, and
        // the caller must keep its existing fast-retry/abort behaviour.
        expect(isRateQuotaCode('session_state_bytes_quota_exceeded')).toBe(false);
        expect(isRateQuotaCode('access_key_count_quota_exceeded')).toBe(false);
        expect(isRateQuotaCode('limit-reached')).toBe(false);
        expect(isRateQuotaCode(undefined)).toBe(false);
        expect(isRateQuotaCode(null)).toBe(false);
        expect(isRateQuotaCode(42)).toBe(false);
    });
});

describe('rateRetryDelayMs', () => {
    it('never waits less than the minimum — the old ≤1s ladder is what caused this', () => {
        for (let attempt = 1; attempt <= 10; attempt += 1) {
            expect(rateRetryDelayMs(attempt, 0)).toBeGreaterThanOrEqual(RATE_RETRY_MIN_DELAY_MS);
        }
        expect(RATE_RETRY_MIN_DELAY_MS).toBeGreaterThan(1_000);
    });

    it('grows with consecutive refusals and stops at the window length', () => {
        expect(rateRetryDelayMs(1, 1 - Number.EPSILON)).toBeCloseTo(RATE_RETRY_MIN_DELAY_MS, -1);
        expect(rateRetryDelayMs(5, 1 - Number.EPSILON)).toBeGreaterThan(rateRetryDelayMs(2, 1 - Number.EPSILON));
        expect(rateRetryDelayMs(50, 1 - Number.EPSILON)).toBe(RATE_RETRY_MAX_DELAY_MS);
        expect(rateRetryDelayMs(1000, 0.5)).toBeLessThanOrEqual(RATE_RETRY_MAX_DELAY_MS);
    });

    it('jitters, so every writer on the account does not march back in lockstep', () => {
        // A bucket refuses all of an account's writers at once; a fixed delay
        // would send them back together to be refused together.
        const low = rateRetryDelayMs(6, 0);
        const high = rateRetryDelayMs(6, 0.99);
        expect(high).toBeGreaterThan(low);
    });

    it('tolerates a nonsense attempt number instead of returning NaN', () => {
        expect(rateRetryDelayMs(0, 0)).toBe(RATE_RETRY_MIN_DELAY_MS);
        expect(rateRetryDelayMs(-3, 0)).toBe(RATE_RETRY_MIN_DELAY_MS);
    });
});

describe('pauseForRateQuota', () => {
    it('sleeps the computed delay and reports it', async () => {
        const sleep = vi.fn(async (_ms: number) => {});
        const log = vi.fn((_message: string) => {});
        const slept = await pauseForRateQuota({
            label: 'session agent state',
            code: 'session_state_rate_quota_exceeded',
            attempt: 1,
            sleep,
            log,
        });
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep.mock.calls[0][0]).toBe(slept);
        expect(slept).toBeGreaterThanOrEqual(RATE_RETRY_MIN_DELAY_MS);
        expect(log.mock.calls[0][0]).toContain('session_state_rate_quota_exceeded');
    });

    it('works without a logger', async () => {
        await expect(pauseForRateQuota({
            label: 'daemon state',
            code: 'machine_state_rate_quota_exceeded',
            attempt: 2,
            sleep: async () => {},
        })).resolves.toBeGreaterThan(0);
    });
});

describe('the writers actually consult it', () => {
    // Source assertions: the value of this module is entirely in being wired
    // into all four state writers. Verified with scripts/dev/mutation-check.mjs.
    const read = (path: string) => require('node:fs').readFileSync(path, 'utf8');

    it('both session writers back off on a rate refusal', () => {
        const source = read('src/api/apiSession.ts');
        expect(source).toContain("label: 'session metadata'");
        expect(source).toContain("label: 'session agent state'");
        expect(source.match(/isRateQuotaCode\(answer\.error\)/g)?.length).toBe(2);
    });

    it('both machine writers do too — and no longer swallow the refusal', () => {
        const source = read('src/api/apiMachine.ts');
        expect(source).toContain("label: 'machine metadata'");
        expect(source).toContain("label: 'daemon state'");
        // Before B-307 neither had an `error` branch at all: a refused machine
        // write returned success-shaped silence and the daemon just stopped
        // reporting its state.
        expect(source).toContain("throw new Error('Machine metadata update failed')");
        expect(source).toContain("throw new Error('Daemon state update failed')");
    });
});
