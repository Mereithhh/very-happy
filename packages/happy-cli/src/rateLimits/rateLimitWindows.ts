/**
 * B-555 — subscription rate-limit windows (spec specs/2026-10-rate-limit-windows.md).
 *
 * Pure normalisation / merge helpers shared by the wrapper (which sees the
 * Claude SDK `rate_limit_event` frames and Codex `account/rateLimits/*`) and
 * the daemon (which merges reports into `daemonState.rateLimits`).
 *
 * Everything here parses defensively: `unifiedWindows` is an `@internal` SDK
 * field and Codex rolling updates are sparse, so a shape change must degrade
 * to "nothing to show", never to a throw.
 */

export type RateLimitProvider = 'claude' | 'codex';

export type RateLimitWindow = {
    /** five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_overage_included | window_<mins>m */
    kind: string;
    /** 0–100, may exceed 100 when usage legitimately runs past the cap. */
    usedPercent: number;
    /** ms epoch, null when unknown. */
    resetsAt: number | null;
    windowMinutes?: number;
    /** ms epoch of the observation that produced this value. */
    observedAt: number;
};

/** One provider's observation as sent wrapper → daemon. */
export type RateLimitReport = {
    provider: RateLimitProvider;
    observedAt: number;
    status?: string;
    windows: RateLimitWindow[];
};

export type ProviderRateLimits = {
    observedAt: number;
    status?: string;
    windows: RateLimitWindow[];
};

/** Shape stored at `daemonState.rateLimits`. */
export type RateLimitsState = {
    v: 1;
    updatedAt: number;
    providers: Record<string, ProviderRateLimits>;
};

const MAX_WINDOWS_PER_PROVIDER = 8;

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Unix seconds → ms; tolerates a value that already looks like ms. */
function epochToMs(value: unknown): number | null {
    const n = finite(value);
    if (n === undefined || n <= 0) return null;
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

const CLAUDE_UNIFIED_KINDS = ['five_hour', 'seven_day', 'seven_day_overage_included'] as const;
const CLAUDE_WINDOW_MINUTES: Record<string, number> = {
    five_hour: 300,
    seven_day: 10080,
    seven_day_opus: 10080,
    seven_day_sonnet: 10080,
    seven_day_overage_included: 10080,
};

/**
 * Claude SDK `rate_limit_event.rate_limit_info` → report windows.
 * - `unifiedWindows.*` (utilization is a 0–1 fraction, resetsAt unix seconds)
 *   carry both windows on every observation.
 * - The top-level `rateLimitType` + `utilization` describe only the limiting
 *   window and only appear past a warning threshold — that is where
 *   `seven_day_opus` / `seven_day_sonnet` show up.
 * Returns null when nothing usable is present (API-key / Bedrock sessions).
 */
export function fromClaudeRateLimitInfo(info: unknown, now: number): RateLimitReport | null {
    if (!info || typeof info !== 'object') return null;
    const raw = info as Record<string, unknown>;
    const windows = new Map<string, RateLimitWindow>();

    const unified = raw.unifiedWindows;
    if (unified && typeof unified === 'object') {
        for (const kind of CLAUDE_UNIFIED_KINDS) {
            const w = (unified as Record<string, unknown>)[kind];
            if (!w || typeof w !== 'object') continue;
            const utilization = finite((w as Record<string, unknown>).utilization);
            if (utilization === undefined || utilization < 0) continue;
            windows.set(kind, {
                kind,
                usedPercent: round2(utilization * 100),
                resetsAt: epochToMs((w as Record<string, unknown>).resetsAt),
                windowMinutes: CLAUDE_WINDOW_MINUTES[kind],
                observedAt: now,
            });
        }
    }

    const status = typeof raw.status === 'string' ? raw.status : undefined;
    const topKind = typeof raw.rateLimitType === 'string' ? raw.rateLimitType : undefined;
    if (topKind && topKind !== 'overage') {
        const utilization = finite(raw.utilization);
        const usedPercent = utilization !== undefined && utilization >= 0
            ? round2(utilization * 100)
            : status === 'rejected' ? 100 : undefined;
        if (usedPercent !== undefined) {
            const prior = windows.get(topKind);
            windows.set(topKind, {
                kind: topKind,
                // The limiting window's own number wins only if it is higher —
                // both describe the same window, the larger is the safer read.
                usedPercent: prior ? Math.max(prior.usedPercent, usedPercent) : usedPercent,
                resetsAt: epochToMs(raw.resetsAt) ?? prior?.resetsAt ?? null,
                windowMinutes: CLAUDE_WINDOW_MINUTES[topKind],
                observedAt: now,
            });
        }
    }

    if (windows.size === 0) return null;
    return {
        provider: 'claude',
        observedAt: now,
        ...(status ? { status } : {}),
        windows: [...windows.values()],
    };
}

function codexKind(windowMinutes: number | undefined, fallback: string): string {
    if (windowMinutes === 300) return 'five_hour';
    if (windowMinutes === 10080) return 'seven_day';
    if (windowMinutes !== undefined) return `window_${windowMinutes}m`;
    return fallback;
}

/**
 * Codex app-server `RateLimitSnapshot` (from `account/rateLimits/updated` or
 * the `rateLimits` of an `account/rateLimits/read` response) → report windows.
 * Rolling updates are sparse: a null primary/secondary means "not in this
 * update", never "cleared", so it simply produces no window.
 * Only the default `codex` limit is taken; per-model limit ids are ignored.
 */
export function fromCodexRateLimits(snapshot: unknown, now: number): RateLimitReport | null {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const raw = snapshot as Record<string, unknown>;
    const limitId = raw.limitId;
    if (limitId !== undefined && limitId !== null && limitId !== 'codex') return null;
    const windows: RateLimitWindow[] = [];
    for (const slot of ['primary', 'secondary'] as const) {
        const w = raw[slot];
        if (!w || typeof w !== 'object') continue;
        const usedPercent = finite((w as Record<string, unknown>).usedPercent);
        if (usedPercent === undefined || usedPercent < 0) continue;
        const windowMinutes = finite((w as Record<string, unknown>).windowDurationMins);
        windows.push({
            kind: codexKind(windowMinutes, slot),
            usedPercent: round2(usedPercent),
            resetsAt: epochToMs((w as Record<string, unknown>).resetsAt),
            ...(windowMinutes !== undefined ? { windowMinutes } : {}),
            observedAt: now,
        });
    }
    if (windows.length === 0) return null;
    return { provider: 'codex', observedAt: now, windows };
}

function sanitizeWindow(value: unknown): RateLimitWindow | null {
    if (!value || typeof value !== 'object') return null;
    const w = value as Record<string, unknown>;
    const kind = typeof w.kind === 'string' && w.kind.length > 0 && w.kind.length <= 64 ? w.kind : null;
    const usedPercent = finite(w.usedPercent);
    const observedAt = finite(w.observedAt);
    if (!kind || usedPercent === undefined || usedPercent < 0 || observedAt === undefined) return null;
    const resetsAt = w.resetsAt === null ? null : finite(w.resetsAt) ?? null;
    const windowMinutes = finite(w.windowMinutes);
    return {
        kind,
        usedPercent,
        resetsAt,
        ...(windowMinutes !== undefined ? { windowMinutes } : {}),
        observedAt,
    };
}

/** Validate a report received over the local control channel. */
export function sanitizeRateLimitReport(value: unknown): RateLimitReport | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (r.provider !== 'claude' && r.provider !== 'codex') return null;
    const observedAt = finite(r.observedAt);
    if (observedAt === undefined || !Array.isArray(r.windows)) return null;
    const windows = r.windows.map(sanitizeWindow).filter((w): w is RateLimitWindow => w !== null)
        .slice(0, MAX_WINDOWS_PER_PROVIDER);
    if (windows.length === 0) return null;
    return {
        provider: r.provider,
        observedAt,
        ...(typeof r.status === 'string' && r.status.length <= 32 ? { status: r.status } : {}),
        windows,
    };
}

function isExpired(window: RateLimitWindow, now: number): boolean {
    return window.resetsAt !== null && window.resetsAt <= now;
}

/** Read whatever is currently stored, dropping anything malformed. */
export function readRateLimitsState(value: unknown): RateLimitsState | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (!raw.providers || typeof raw.providers !== 'object') return null;
    const providers: Record<string, ProviderRateLimits> = {};
    for (const [name, p] of Object.entries(raw.providers as Record<string, unknown>)) {
        if (!p || typeof p !== 'object') continue;
        const observedAt = finite((p as Record<string, unknown>).observedAt);
        const windowsRaw = (p as Record<string, unknown>).windows;
        if (observedAt === undefined || !Array.isArray(windowsRaw)) continue;
        const windows = windowsRaw.map(sanitizeWindow).filter((w): w is RateLimitWindow => w !== null);
        const status = (p as Record<string, unknown>).status;
        providers[name] = { observedAt, ...(typeof status === 'string' ? { status } : {}), windows };
    }
    return { v: 1, updatedAt: finite(raw.updatedAt) ?? 0, providers };
}

/**
 * Merge one report into the stored state. Windows merge by `kind`; a newer
 * observation replaces an older one; windows past their reset are dropped
 * (the usage they describe is gone). Other providers are carried unchanged.
 */
export function mergeRateLimits(current: unknown, report: RateLimitReport, now: number): RateLimitsState {
    const base = readRateLimitsState(current) ?? { v: 1 as const, updatedAt: 0, providers: {} };
    const prior = base.providers[report.provider];
    const byKind = new Map<string, RateLimitWindow>();
    for (const w of prior?.windows ?? []) byKind.set(w.kind, w);
    for (const w of report.windows) {
        const existing = byKind.get(w.kind);
        if (!existing || w.observedAt >= existing.observedAt) byKind.set(w.kind, w);
    }
    const windows = [...byKind.values()]
        .filter((w) => !isExpired(w, now))
        .slice(0, MAX_WINDOWS_PER_PROVIDER);

    const providers: Record<string, ProviderRateLimits> = {};
    for (const [name, p] of Object.entries(base.providers)) {
        if (name === report.provider) continue;
        providers[name] = { ...p, windows: p.windows.filter((w) => !isExpired(w, now)) };
    }
    const newer = !prior || report.observedAt >= prior.observedAt;
    providers[report.provider] = {
        observedAt: newer ? report.observedAt : prior.observedAt,
        ...((newer ? report.status : prior?.status) ? { status: newer ? report.status : prior?.status } : {}),
        windows,
    };
    return { v: 1, updatedAt: now, providers };
}

/**
 * Change-detection key: what a viewer would notice (rounded percent, reset
 * minute, status). Observation timestamps are deliberately excluded so a
 * repeat of the same numbers does not cost a daemonState write.
 */
export function rateLimitSignature(state: RateLimitsState | null | undefined): string {
    if (!state) return '';
    return Object.keys(state.providers).sort().map((name) => {
        const p = state.providers[name];
        const windows = [...p.windows]
            .sort((a, b) => a.kind.localeCompare(b.kind))
            .map((w) => `${w.kind}:${Math.round(w.usedPercent)}:${w.resetsAt === null ? '-' : Math.round(w.resetsAt / 60_000)}`)
            .join(',');
        return `${name}[${p.status ?? ''}]{${windows}}`;
    }).join(';');
}

/** Signature of a single report (wrapper-side dedupe). */
export function rateLimitReportSignature(report: RateLimitReport): string {
    return rateLimitSignature({ v: 1, updatedAt: 0, providers: { [report.provider]: report } });
}

/** Codex `account/rateLimits/read` is a pull: at most once per 10 minutes per wrapper. */
export const CODEX_RATE_LIMIT_READ_MIN_INTERVAL_MS = 10 * 60_000;

export function shouldReadCodexRateLimits(state: {
    now: number;
    lastReadAt: number;
    inFlight: boolean;
    unsupported: boolean;
}): boolean {
    if (state.unsupported || state.inFlight) return false;
    return state.lastReadAt === 0 || state.now - state.lastReadAt >= CODEX_RATE_LIMIT_READ_MIN_INTERVAL_MS;
}

/**
 * An app-server that does not know the method (older Codex) answers a
 * JSON-RPC "method not found"/"invalid request" or serde's "unknown variant".
 * Those are permanent for the process; anything else (network, auth) just
 * waits for the next interval.
 */
export function isUnsupportedCodexMethodError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return /\(code=-3260[01]\)/.test(message) || /unknown variant/i.test(message);
}

/** Same numbers still count as news once the stored observation is this old. */
export const RATE_LIMIT_OBSERVED_REFRESH_MS = 30 * 60_000;

/** Fold a batch of reports into the stored value. */
export function mergeRateLimitReports(current: unknown, reports: readonly RateLimitReport[], now: number): RateLimitsState | null {
    let merged: RateLimitsState | null = readRateLimitsState(current);
    for (const report of reports) merged = mergeRateLimits(merged, report, now);
    return merged;
}

/**
 * Daemon write gate: the merged value when it is worth a daemonState write
 * (a viewer-visible change, or the same numbers re-observed after
 * {@link RATE_LIMIT_OBSERVED_REFRESH_MS} so the web's staleness label stays
 * honest), otherwise null.
 */
export function planRateLimitWrite(current: unknown, reports: readonly RateLimitReport[], now: number): RateLimitsState | null {
    if (reports.length === 0) return null;
    const before = readRateLimitsState(current);
    const merged = mergeRateLimitReports(current, reports, now);
    if (!merged) return null;
    if (rateLimitSignature(merged) !== rateLimitSignature(before)) return merged;
    for (const report of reports) {
        const prior = before?.providers[report.provider];
        const next = merged.providers[report.provider];
        if (!prior || (next && next.observedAt - prior.observedAt >= RATE_LIMIT_OBSERVED_REFRESH_MS)) return merged;
    }
    return null;
}
