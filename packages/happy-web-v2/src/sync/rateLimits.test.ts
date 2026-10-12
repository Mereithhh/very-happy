import { describe, expect, it } from 'vitest';
import {
    barPercent,
    fallbackWindowLabel,
    formatResetIn,
    isRateLimitStale,
    parseRateLimits,
    rateLimitTone,
    readMachineRateLimits,
    tightestRateLimit,
    RATE_LIMIT_STALE_AFTER_MS,
    RATE_LIMIT_MAX_RESET_AHEAD_MS,
    RATE_LIMIT_NULL_RESET_MAX_AGE_MS,
    visibleWindows,
} from './rateLimits';

const NOW = 1_791_800_000_000;
const H = 3_600_000;

const win = (kind: string, usedPercent: number, extra: Record<string, unknown> = {}) => ({
    kind, usedPercent, resetsAt: NOW + 2 * H, observedAt: NOW - 1000, ...extra,
});
const state = (providers: Record<string, unknown>) => ({ status: 'running', rateLimits: { v: 1, updatedAt: NOW, providers } });

describe('parseRateLimits (B-555)', () => {
    it('returns nothing for an old CLI or garbage, never throws', () => {
        expect(parseRateLimits(null)).toEqual([]);
        expect(parseRateLimits({ status: 'running' })).toEqual([]);
        expect(parseRateLimits({ rateLimits: 'x' })).toEqual([]);
        expect(parseRateLimits({ rateLimits: { providers: 5 } })).toEqual([]);
        expect(parseRateLimits({ rateLimits: { providers: { claude: { observedAt: 'x', windows: [] } } } })).toEqual([]);
    });

    it('keeps good windows next to bad ones and tolerates unknown fields/kinds', () => {
        const parsed = parseRateLimits(state({
            claude: {
                observedAt: NOW, status: 'allowed', future: true,
                windows: [win('five_hour', 42, { extra: 1 }), { kind: 'seven_day', usedPercent: 'many' }, win('new_window_kind', 3, { resetsAt: null })],
            },
            gemini: { observedAt: NOW, windows: [] },
        }));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].windows.map((w) => w.kind)).toEqual(['five_hour', 'new_window_kind']);
        expect(parsed[0].windows[1].resetsAt).toBeNull();
    });
});

describe('presentation helpers (B-555)', () => {
    it('tone: >80 warn, >95 danger', () => {
        expect(rateLimitTone(80)).toBe('normal');
        expect(rateLimitTone(80.5)).toBe('warn');
        expect(rateLimitTone(95)).toBe('warn');
        expect(rateLimitTone(95.1)).toBe('danger');
        expect(rateLimitTone(130)).toBe('danger');
    });

    it('stale after 6h', () => {
        expect(isRateLimitStale(NOW - RATE_LIMIT_STALE_AFTER_MS, NOW)).toBe(false);
        expect(isRateLimitStale(NOW - RATE_LIMIT_STALE_AFTER_MS - 1, NOW)).toBe(true);
    });

    it('formats the reset countdown', () => {
        expect(formatResetIn(null, NOW)).toBeNull();
        expect(formatResetIn(NOW - 1, NOW)).toBeNull();
        expect(formatResetIn(NOW + 30_000, NOW)).toBe('<1m');
        expect(formatResetIn(NOW + 42 * 60_000, NOW)).toBe('42m');
        expect(formatResetIn(NOW + 2 * H + 13 * 60_000, NOW)).toBe('2h 13m');
        expect(formatResetIn(NOW + 76 * H, NOW)).toBe('3d 4h');
    });

    it('clamps the bar and labels unknown windows from their length', () => {
        expect(barPercent(130)).toBe(100);
        expect(barPercent(-1)).toBe(0);
        expect(fallbackWindowLabel({ kind: 'window_60m', windowMinutes: 60 })).toBe('1h');
        expect(fallbackWindowLabel({ kind: 'window_2880m', windowMinutes: 2880 })).toBe('2d');
        expect(fallbackWindowLabel({ kind: 'secondary' })).toBe('secondary');
    });
});

describe('machine + account selection (B-555)', () => {
    it('hides windows past their reset and orders Claude before Codex', () => {
        const machine = { daemonState: state({
            codex: { observedAt: NOW, windows: [win('five_hour', 10)] },
            claude: { observedAt: NOW, windows: [win('five_hour', 5, { resetsAt: NOW - 1 }), win('seven_day', 20)] },
        }) };
        const out = readMachineRateLimits(machine, NOW);
        expect(out.map((p) => p.provider)).toEqual(['claude', 'codex']);
        expect(out[0].windows.map((w) => w.kind)).toEqual(['seven_day']);
        expect(readMachineRateLimits({ daemonState: state({ claude: { observedAt: NOW, windows: [win('five_hour', 5, { resetsAt: NOW - 1 })] } }) }, NOW)).toEqual([]);
    });

    it('tightest: fresh beats stale, then highest usage, then soonest reset', () => {
        const machines = [
            { id: 'a', daemonState: state({ claude: { observedAt: NOW, windows: [win('five_hour', 40), win('seven_day', 70, { resetsAt: NOW + 50 * H })] } }) },
            { id: 'b', daemonState: state({ codex: { observedAt: NOW, windows: [win('seven_day', 70, { resetsAt: NOW + 10 * H })] } }) },
            { id: 'c', daemonState: state({ claude: { observedAt: NOW - 7 * H, windows: [win('seven_day', 99, { observedAt: NOW - 7 * H, resetsAt: NOW + 5 * H })] } }) },
            { id: 'old-cli', daemonState: { status: 'running' } },
        ];
        const tight = tightestRateLimit(machines, NOW);
        expect(tight).toMatchObject({ machineId: 'b', provider: 'codex', stale: false, window: { kind: 'seven_day', usedPercent: 70 } });
        expect(tightestRateLimit([machines[2]], NOW)).toMatchObject({ machineId: 'c', stale: true });
        expect(tightestRateLimit([machines[3]], NOW)).toBeNull();
        expect(tightestRateLimit([], NOW)).toBeNull();
    });
});

describe('visibleWindows plausibility (B-555 review)', () => {
    it('shows a reset more than 30 days ahead as unknown', () => {
        const [far, ok] = visibleWindows([
            win('five_hour', 1, { resetsAt: NOW + RATE_LIMIT_MAX_RESET_AHEAD_MS + 1 }),
            win('seven_day', 1, { resetsAt: NOW + RATE_LIMIT_MAX_RESET_AHEAD_MS }),
        ] as any, NOW);
        expect(far.resetsAt).toBeNull();
        expect(ok.resetsAt).toBe(NOW + RATE_LIMIT_MAX_RESET_AHEAD_MS);
    });

    it('hides a reset-less window observed more than 7 days ago, including one whose reset was implausible', () => {
        const out = visibleWindows([
            win('a', 1, { resetsAt: null, observedAt: NOW - RATE_LIMIT_NULL_RESET_MAX_AGE_MS - 1 }),
            win('b', 1, { resetsAt: null, observedAt: NOW - RATE_LIMIT_NULL_RESET_MAX_AGE_MS + 1 }),
            win('c', 1, { resetsAt: NOW + 60 * 86_400_000, observedAt: NOW - RATE_LIMIT_NULL_RESET_MAX_AGE_MS - 1 }),
        ] as any, NOW);
        expect(out.map((w) => w.kind)).toEqual(['b']);
    });
});
