import { z } from 'zod';
import type { Machine } from './storageTypes';

/**
 * B-555 — subscription rate-limit windows published by the daemon at
 * `daemonState.rateLimits` (spec specs/2026-10-rate-limit-windows.md).
 *
 * daemonState is `any` on the web and old CLIs never write this field, so the
 * parser is the single gate: anything missing or malformed yields `null` /
 * fewer windows, never a throw. Each window is parsed on its own so one bad
 * entry from a newer CLI cannot hide the rest.
 */

const WindowSchema = z.object({
    kind: z.string().min(1).max(64),
    usedPercent: z.number().finite().nonnegative(),
    resetsAt: z.number().finite().nullable().optional(),
    windowMinutes: z.number().finite().optional(),
    observedAt: z.number().finite(),
});

const ProviderSchema = z.object({
    observedAt: z.number().finite(),
    status: z.string().optional(),
    windows: z.array(z.unknown()),
});

export type RateLimitWindow = {
    kind: string;
    usedPercent: number;
    resetsAt: number | null;
    windowMinutes?: number;
    observedAt: number;
};

export type ProviderRateLimits = {
    provider: string;
    observedAt: number;
    status?: string;
    windows: RateLimitWindow[];
};

/** Above this share of a window: warn tone. */
export const RATE_LIMIT_WARN_PERCENT = 80;
/** Above this share of a window: danger tone. */
export const RATE_LIMIT_DANGER_PERCENT = 95;
/** An observation older than this is shown dimmed with its time. */
export const RATE_LIMIT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function parseRateLimits(daemonState: unknown): ProviderRateLimits[] {
    if (!daemonState || typeof daemonState !== 'object') return [];
    const raw = (daemonState as { rateLimits?: unknown }).rateLimits;
    if (!raw || typeof raw !== 'object') return [];
    const providers = (raw as { providers?: unknown }).providers;
    if (!providers || typeof providers !== 'object') return [];
    const out: ProviderRateLimits[] = [];
    for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
        const parsed = ProviderSchema.safeParse(value);
        if (!parsed.success) continue;
        const windows: RateLimitWindow[] = [];
        for (const w of parsed.data.windows) {
            const pw = WindowSchema.safeParse(w);
            if (!pw.success) continue;
            windows.push({
                kind: pw.data.kind,
                usedPercent: pw.data.usedPercent,
                resetsAt: pw.data.resetsAt ?? null,
                ...(pw.data.windowMinutes !== undefined ? { windowMinutes: pw.data.windowMinutes } : {}),
                observedAt: pw.data.observedAt,
            });
        }
        if (windows.length === 0) continue;
        out.push({
            provider,
            observedAt: parsed.data.observedAt,
            ...(parsed.data.status ? { status: parsed.data.status } : {}),
            windows,
        });
    }
    return out;
}

/** A reset further out than this is implausible for any plan window — shown as unknown. */
export const RATE_LIMIT_MAX_RESET_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** A window with no reset time is hidden once its observation is this old. */
export const RATE_LIMIT_NULL_RESET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What can still be shown: a reset more than 30 days out becomes "unknown";
 * a window past its reset (usage gone) or reset-less and observed more than
 * 7 days ago is hidden. Mirrors the CLI merge rules for data an older or
 * newer daemon may have written.
 */
export function visibleWindows(windows: readonly RateLimitWindow[], now: number): RateLimitWindow[] {
    const out: RateLimitWindow[] = [];
    for (const w of windows) {
        const resetsAt = w.resetsAt !== null && w.resetsAt - now > RATE_LIMIT_MAX_RESET_AHEAD_MS ? null : w.resetsAt;
        if (resetsAt === null ? now - w.observedAt > RATE_LIMIT_NULL_RESET_MAX_AGE_MS : resetsAt <= now) continue;
        out.push(resetsAt === w.resetsAt ? w : { ...w, resetsAt });
    }
    return out;
}

export type RateLimitTone = 'normal' | 'warn' | 'danger';

export function rateLimitTone(usedPercent: number): RateLimitTone {
    if (usedPercent > RATE_LIMIT_DANGER_PERCENT) return 'danger';
    if (usedPercent > RATE_LIMIT_WARN_PERCENT) return 'warn';
    return 'normal';
}

export function isRateLimitStale(observedAt: number, now: number): boolean {
    return now - observedAt > RATE_LIMIT_STALE_AFTER_MS;
}

/** Compact countdown: `<1m`, `42m`, `2h 13m`, `3d 4h`. Null when unknown. */
export function formatResetIn(resetsAt: number | null, now: number): string | null {
    if (resetsAt === null) return null;
    const ms = resetsAt - now;
    if (ms <= 0) return null;
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

/** Bar width: clamp to 0–100 (usage can legitimately exceed the cap). */
export function barPercent(usedPercent: number): number {
    return Math.max(0, Math.min(100, usedPercent));
}

export type KnownRateLimitKind =
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
    | 'seven_day_overage_included';

const KNOWN_KINDS = new Set<string>(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included']);

export function isKnownRateLimitKind(kind: string): kind is KnownRateLimitKind {
    return KNOWN_KINDS.has(kind);
}

/** Fallback label for kinds this build has no copy for (`window_60m` → `60m`). */
export function fallbackWindowLabel(window: Pick<RateLimitWindow, 'kind' | 'windowMinutes'>): string {
    const minutes = window.windowMinutes;
    if (minutes !== undefined && minutes > 0) {
        if (minutes % 1440 === 0) return `${minutes / 1440}d`;
        if (minutes % 60 === 0) return `${minutes / 60}h`;
        return `${minutes}m`;
    }
    return window.kind.replace(/_/g, ' ');
}

export function providerLabel(provider: string): string {
    if (provider === 'claude') return 'Claude';
    if (provider === 'codex') return 'Codex';
    return provider;
}

/** Provider order on screen: Claude, Codex, then anything newer alphabetically. */
export function sortProviders<T extends { provider: string }>(list: readonly T[]): T[] {
    const rank = (p: string) => (p === 'claude' ? 0 : p === 'codex' ? 1 : 2);
    return [...list].sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider));
}

export function readMachineRateLimits(machine: Pick<Machine, 'daemonState'> | null | undefined, now: number): ProviderRateLimits[] {
    if (!machine) return [];
    return sortProviders(parseRateLimits(machine.daemonState)
        .map((p) => ({ ...p, windows: visibleWindows(p.windows, now) }))
        .filter((p) => p.windows.length > 0));
}

export type TightestRateLimit = {
    machineId: string;
    provider: string;
    window: RateLimitWindow;
    stale: boolean;
};

/**
 * The one window the sidebar shows: across all machines, fresh observations
 * first, then the highest usage, then the soonest reset.
 */
export function tightestRateLimit(
    machines: readonly Pick<Machine, 'id' | 'daemonState'>[],
    now: number,
): TightestRateLimit | null {
    let best: TightestRateLimit | null = null;
    for (const machine of machines) {
        for (const p of readMachineRateLimits(machine, now)) {
            for (const window of p.windows) {
                const candidate: TightestRateLimit = {
                    machineId: machine.id,
                    provider: p.provider,
                    window,
                    stale: isRateLimitStale(window.observedAt, now),
                };
                if (!best || compareTightness(candidate, best) < 0) best = candidate;
            }
        }
    }
    return best;
}

function compareTightness(a: TightestRateLimit, b: TightestRateLimit): number {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    if (a.window.usedPercent !== b.window.usedPercent) return b.window.usedPercent - a.window.usedPercent;
    const ar = a.window.resetsAt ?? Number.POSITIVE_INFINITY;
    const br = b.window.resetsAt ?? Number.POSITIVE_INFINITY;
    return ar - br;
}
