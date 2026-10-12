import { describe, expect, it } from 'vitest';
import {
    fromClaudeRateLimitInfo,
    fromCodexRateLimits,
    isUnsupportedCodexMethodError,
    mergeRateLimits,
    planRateLimitWrite,
    rateLimitSignature,
    readRateLimitsState,
    sanitizeRateLimitReport,
    shouldReadCodexRateLimits,
    CODEX_RATE_LIMIT_READ_MIN_INTERVAL_MS,
    RATE_LIMIT_OBSERVED_REFRESH_MS,
} from './rateLimitWindows';

const NOW = 1_791_800_000_000;

describe('fromClaudeRateLimitInfo (B-555)', () => {
    it('maps the real 2.1.296 frame: unifiedWindows fraction → percent, unix seconds → ms', () => {
        // Captured 2026-10-12 from SDK 0.3.296 in an isolated probe (spec "数据来源核实").
        const info = {
            status: 'allowed', resetsAt: 1791826800, rateLimitType: 'five_hour', overageStatus: 'allowed',
            overageResetsAt: 1793491200, isUsingOverage: false,
            unifiedWindows: {
                five_hour: { utilization: 0.02, resetsAt: 1791826800 },
                seven_day: { utilization: 0.12, resetsAt: 1792252800 },
            },
        };
        expect(fromClaudeRateLimitInfo(info, NOW)).toEqual({
            provider: 'claude',
            observedAt: NOW,
            status: 'allowed',
            windows: [
                { kind: 'five_hour', usedPercent: 2, resetsAt: 1791826800_000, windowMinutes: 300, observedAt: NOW },
                { kind: 'seven_day', usedPercent: 12, resetsAt: 1792252800_000, windowMinutes: 10080, observedAt: NOW },
            ],
        });
    });

    it('adds the limiting per-model window from the top-level fields (warning state)', () => {
        const report = fromClaudeRateLimitInfo({
            status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.86, resetsAt: 1792252800,
            unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1791826800 } },
        }, NOW);
        expect(report?.status).toBe('allowed_warning');
        expect(report?.windows.map((w) => [w.kind, w.usedPercent])).toEqual([['five_hour', 40], ['seven_day_opus', 86]]);
    });

    it('keeps the higher of unified and top-level numbers for the same window', () => {
        const report = fromClaudeRateLimitInfo({
            status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: 1791826800,
            unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: 1791826800 } },
        }, NOW);
        expect(report?.windows).toHaveLength(1);
        expect(report?.windows[0].usedPercent).toBe(81);
    });

    it('treats a rejected limit without utilization as 100%', () => {
        const report = fromClaudeRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792252800 }, NOW);
        expect(report?.windows).toEqual([{ kind: 'seven_day', usedPercent: 100, resetsAt: 1792252800_000, windowMinutes: 10080, observedAt: NOW }]);
    });

    it('returns null when nothing usable is present (API key, overage-only, garbage)', () => {
        expect(fromClaudeRateLimitInfo({ status: 'allowed' }, NOW)).toBeNull();
        expect(fromClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1 }, NOW)).toBeNull();
        expect(fromClaudeRateLimitInfo({ status: 'allowed_warning', rateLimitType: 'overage', utilization: 0.9 }, NOW)).toBeNull();
        expect(fromClaudeRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 'x' } } }, NOW)).toBeNull();
        expect(fromClaudeRateLimitInfo(null, NOW)).toBeNull();
        expect(fromClaudeRateLimitInfo('nope', NOW)).toBeNull();
    });
});

describe('fromCodexRateLimits (B-555)', () => {
    it('maps a read result: 300/10080 minute windows to five_hour/seven_day', () => {
        // Shape captured 2026-10-12 from codex-cli 0.154.0 `account/rateLimits/read`.
        const report = fromCodexRateLimits({
            limitId: 'codex', limitName: null,
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791836601 },
            secondary: { usedPercent: 37.5, windowDurationMins: 10080, resetsAt: 1792377533 },
            planType: 'team',
        }, NOW);
        expect(report).toEqual({
            provider: 'codex', observedAt: NOW,
            windows: [
                { kind: 'five_hour', usedPercent: 0, resetsAt: 1791836601_000, windowMinutes: 300, observedAt: NOW },
                { kind: 'seven_day', usedPercent: 37.5, resetsAt: 1792377533_000, windowMinutes: 10080, observedAt: NOW },
            ],
        });
    });

    it('a sparse rolling update (null windows) produces nothing, so it cannot clear stored values', () => {
        expect(fromCodexRateLimits({ limitId: 'codex', primary: null, secondary: null, credits: null }, NOW)).toBeNull();
    });

    it('ignores non-default limit ids and names odd window lengths', () => {
        expect(fromCodexRateLimits({ limitId: 'gpt-x', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 } }, NOW)).toBeNull();
        expect(fromCodexRateLimits({ primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null } }, NOW)?.windows[0])
            .toMatchObject({ kind: 'window_60m', resetsAt: null });
        expect(fromCodexRateLimits({ secondary: { usedPercent: 5, windowDurationMins: null, resetsAt: null } }, NOW)?.windows[0].kind)
            .toBe('secondary');
    });
});

describe('merge / signature / write plan (B-555)', () => {
    const claude = (usedPercent: number, observedAt = NOW, kind = 'five_hour', resetsAt: number | null = NOW + 3_600_000) => ({
        provider: 'claude' as const, observedAt, windows: [{ kind, usedPercent, resetsAt, observedAt }],
    });

    it('merges by kind, newer observation wins, other providers carried', () => {
        let state = mergeRateLimits(undefined, claude(10), NOW);
        state = mergeRateLimits(state, { provider: 'codex', observedAt: NOW, windows: [{ kind: 'seven_day', usedPercent: 3, resetsAt: null, observedAt: NOW }] }, NOW);
        state = mergeRateLimits(state, claude(40, NOW + 1, 'seven_day'), NOW + 1);
        state = mergeRateLimits(state, claude(5, NOW - 10), NOW + 2); // older five_hour observation loses
        expect(state.providers.claude.windows.map((w) => [w.kind, w.usedPercent])).toEqual([['five_hour', 10], ['seven_day', 40]]);
        expect(state.providers.claude.observedAt).toBe(NOW + 1);
        expect(state.providers.codex.windows[0].usedPercent).toBe(3);
    });

    it('drops windows past their reset and malformed stored entries', () => {
        const state = mergeRateLimits({
            v: 1, updatedAt: 0, providers: {
                claude: { observedAt: NOW, windows: [{ kind: 'seven_day', usedPercent: 50, resetsAt: NOW - 1, observedAt: NOW - 5 }, { kind: 7 }] },
                junk: 'x',
            },
        }, claude(20), NOW);
        expect(state.providers.claude.windows.map((w) => w.kind)).toEqual(['five_hour']);
        expect(Object.keys(state.providers)).toEqual(['claude']);
    });

    it('signature ignores observation time but tracks rounded percent and reset minute', () => {
        const a = mergeRateLimits(undefined, claude(10.2), NOW);
        const b = mergeRateLimits(undefined, claude(10.4, NOW + 5000), NOW + 5000);
        const c = mergeRateLimits(undefined, claude(11), NOW);
        expect(rateLimitSignature(a)).toBe(rateLimitSignature(b));
        expect(rateLimitSignature(a)).not.toBe(rateLimitSignature(c));
        expect(rateLimitSignature(null)).toBe('');
    });

    it('plans a write only on visible change or after the observed refresh interval', () => {
        const stored = mergeRateLimits(undefined, claude(10), NOW);
        expect(planRateLimitWrite(undefined, [claude(10)], NOW)).not.toBeNull();
        expect(planRateLimitWrite(stored, [claude(10, NOW + 1000)], NOW + 1000)).toBeNull();
        expect(planRateLimitWrite(stored, [claude(12, NOW + 1000)], NOW + 1000)).not.toBeNull();
        const later = NOW + RATE_LIMIT_OBSERVED_REFRESH_MS;
        expect(planRateLimitWrite(stored, [claude(10, later)], later)?.providers.claude.observedAt).toBe(later);
        expect(planRateLimitWrite(stored, [], NOW)).toBeNull();
    });

    it('readRateLimitsState tolerates garbage', () => {
        expect(readRateLimitsState(undefined)).toBeNull();
        expect(readRateLimitsState({ providers: 3 })).toBeNull();
        expect(readRateLimitsState({ providers: {} })).toEqual({ v: 1, updatedAt: 0, providers: {} });
    });
});

describe('sanitizeRateLimitReport (control channel, B-555)', () => {
    it('accepts a report and keeps only known fields', () => {
        expect(sanitizeRateLimitReport({
            provider: 'claude', observedAt: NOW, status: 'allowed', extra: 1,
            windows: [{ kind: 'five_hour', usedPercent: 2, resetsAt: null, observedAt: NOW, junk: true }, { kind: '' }],
        })).toEqual({ provider: 'claude', observedAt: NOW, status: 'allowed', windows: [{ kind: 'five_hour', usedPercent: 2, resetsAt: null, observedAt: NOW }] });
    });

    it('rejects unknown providers and empty window lists', () => {
        expect(sanitizeRateLimitReport({ provider: 'gemini', observedAt: NOW, windows: [] })).toBeNull();
        expect(sanitizeRateLimitReport({ provider: 'codex', observedAt: NOW, windows: [{ kind: 'x' }] })).toBeNull();
        expect(sanitizeRateLimitReport(null)).toBeNull();
    });
});

describe('codex read policy (B-555)', () => {
    it('reads first time, then at most every interval, never when unsupported or in flight', () => {
        const base = { now: NOW, lastReadAt: 0, inFlight: false, unsupported: false };
        expect(shouldReadCodexRateLimits(base)).toBe(true);
        expect(shouldReadCodexRateLimits({ ...base, lastReadAt: NOW - 1000 })).toBe(false);
        expect(shouldReadCodexRateLimits({ ...base, lastReadAt: NOW - CODEX_RATE_LIMIT_READ_MIN_INTERVAL_MS })).toBe(true);
        expect(shouldReadCodexRateLimits({ ...base, unsupported: true })).toBe(false);
        expect(shouldReadCodexRateLimits({ ...base, inFlight: true })).toBe(false);
    });

    it('treats method-not-found / unknown-variant as permanent, other errors as transient', () => {
        expect(isUnsupportedCodexMethodError(new Error('account/rateLimits/read: Method not found (code=-32601)'))).toBe(true);
        expect(isUnsupportedCodexMethodError(new Error('account/rateLimits/read: Invalid request: unknown variant `account/rateLimits/read` (code=-32600)'))).toBe(true);
        expect(isUnsupportedCodexMethodError(new Error('account/rateLimits/read: network error (code=-32000)'))).toBe(false);
        expect(isUnsupportedCodexMethodError(new Error('account/rateLimits/read timed out after 15000ms (id=4)'))).toBe(false);
    });
});
