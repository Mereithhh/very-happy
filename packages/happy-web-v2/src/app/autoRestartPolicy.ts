/**
 * autoRestartPolicy (B-852) — the daemon restarts sessions a CLI upgrade left
 * on old code by itself once they are provably idle (spec
 * `specs/2026-10-auto-restart-stale-wrappers.md`). This decides when the
 * restart banners (B-462 StaleWrapperBanner, B-487 ModelSupportBanner's
 * restart) still need a human: the daemon can never prove the session idle
 * (`manual`), it tried and failed, or it has been waiting for a long time.
 *
 * Pure rules only (no store / network imports).
 */

/** A waiting session shows its explanation (and the manual button) after this. */
export const AUTO_RESTART_LONG_WAIT_MS = 60 * 60 * 1000;
/** Right after a daemon (re)start it classifies its sessions within ~1 min; stay quiet meanwhile. */
export const AUTO_RESTART_CLASSIFY_GRACE_MS = 3 * 60 * 1000;
/** `kind` of the service line an automatically restarted wrapper posts. */
export const AUTO_UPDATED_EVENT_KIND = 'session-auto-updated';

export interface AutoRestartSessionStatus {
    state: 'waiting' | 'restarting' | 'failed' | 'manual' | string;
    reason?: string;
    since: number;
    target: string;
    /** `failed` only: the old wrapper was stopped and the new one never came up — the session is offline. */
    offline?: boolean;
    /** offline failure: the daemon retries once by itself at this time; absent = left to Restore. */
    retryAt?: number;
}

export interface MachineAutoRestart {
    enabled: boolean;
    sessions: Record<string, AutoRestartSessionStatus>;
    /** This daemon run's start (ms), for the classification grace. */
    startedAt: number | null;
}

/** `daemonState.autoRestart`, trusted only when written by THIS daemon run (same rule as every capability). */
export function readMachineAutoRestart(daemonState: unknown): MachineAutoRestart | null {
    const state = daemonState as { startedAt?: unknown; autoRestart?: { enabled?: unknown; rpcAvailable?: unknown; detectedAt?: unknown; sessions?: unknown } } | null | undefined;
    const ar = state?.autoRestart;
    if (!ar || ar.rpcAvailable !== true || typeof ar.enabled !== 'boolean' || typeof ar.detectedAt !== 'number') return null;
    const startedAt = typeof state?.startedAt === 'number' ? state.startedAt : null;
    if (startedAt !== null && ar.detectedAt < startedAt) return null;
    const sessions: Record<string, AutoRestartSessionStatus> = {};
    if (ar.sessions && typeof ar.sessions === 'object') {
        for (const [id, raw] of Object.entries(ar.sessions as Record<string, unknown>)) {
            const s = raw as Partial<AutoRestartSessionStatus> | null;
            if (!s || typeof s.state !== 'string' || typeof s.since !== 'number' || typeof s.target !== 'string') continue;
            sessions[id] = {
                state: s.state, since: s.since, target: s.target,
                ...(typeof s.reason === 'string' ? { reason: s.reason } : {}),
                ...(s.offline === true ? { offline: true } : {}),
                ...(typeof s.retryAt === 'number' ? { retryAt: s.retryAt } : {}),
            };
        }
    }
    return { enabled: ar.enabled, sessions, startedAt };
}

export type RestartBannerMode =
    /**
     * Old daemon, switch off, or the daemon can never prove it idle: the
     * B-462/B-487 banner as before; `reason` = the daemon's why (e.g.
     * `local-terminal`), shown when the banner has words for it.
     */
    | { kind: 'manual'; reason?: string }
    /** The daemon is on it (or about to classify it): no banner. */
    | { kind: 'auto' }
    /** Waiting for a long time: say why it has not updated yet; the manual button stays. */
    | { kind: 'waiting'; reason: string }
    /** It tried and gave up: say why; the manual button stays. */
    | { kind: 'failed'; reason: string };

/**
 * `missing` = what a session the daemon has not listed means: `grace` for a
 * wrapper-version notice (the daemon lists every stale wrapper within a
 * minute), `manual` for a notice the daemon may not know about (Codex whose
 * old wrapper cannot report its agent version).
 */
export function restartBannerMode(
    sessionId: string,
    autoRestart: MachineAutoRestart | null,
    now: number,
    missing: 'grace' | 'manual' = 'grace',
): RestartBannerMode {
    if (!autoRestart || !autoRestart.enabled) return { kind: 'manual' };
    const status = autoRestart.sessions[sessionId];
    if (!status) {
        if (missing === 'manual') return { kind: 'manual' };
        const inGrace = autoRestart.startedAt !== null && now - autoRestart.startedAt < AUTO_RESTART_CLASSIFY_GRACE_MS;
        return inGrace ? { kind: 'auto' } : { kind: 'manual' };
    }
    if (status.state === 'restarting') return { kind: 'auto' };
    if (status.state === 'failed') return { kind: 'failed', reason: status.reason ?? '' };
    if (status.state === 'waiting') {
        return now - status.since >= AUTO_RESTART_LONG_WAIT_MS
            ? { kind: 'waiting', reason: status.reason ?? '' }
            : { kind: 'auto' };
    }
    return status.reason ? { kind: 'manual', reason: status.reason } : { kind: 'manual' };
}

/**
 * QA25 P2-2: an automatic restart stopped the old wrapper and the new one
 * never came up, so the session is offline and only the Restore banner shows.
 * That banner says why, and whether the daemon will try once more by itself.
 */
export function offlineAutoRestartFailure(sessionId: string, autoRestart: MachineAutoRestart | null): { reason: string; retryAt: number | null } | null {
    const status = autoRestart?.sessions[sessionId];
    if (!status || status.state !== 'failed' || status.offline !== true) return null;
    return { reason: status.reason ?? '', retryAt: status.retryAt ?? null };
}

/** Waiting reasons the banner explains in words; anything else gets the generic line. */
export const AUTO_RESTART_WAIT_REASONS = [
    'turn-active',
    'pending-request',
    'queued-input',
    'background-tasks',
    'scheduled-wakeup',
    'recent-activity',
    'automation-running',
] as const;
export type AutoRestartWaitReason = typeof AUTO_RESTART_WAIT_REASONS[number] | 'other';

export function waitReasonKey(reason: string): AutoRestartWaitReason {
    return (AUTO_RESTART_WAIT_REASONS as readonly string[]).includes(reason) ? reason as AutoRestartWaitReason : 'other';
}

/** A daemon failure string → a short, readable cause (the raw text is still in the daemon log). */
export function failureSummary(reason: string): string {
    const trimmed = reason.trim();
    const precheck = /^restart-precheck:([a-z-]+)/.exec(trimmed);
    if (precheck) return precheck[1];
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/** The restarted wrapper's service line → the version it now runs (and the agent, for a Codex-only update). */
export function parseAutoUpdatedLine(message: string): { agent: string | null; version: string } | null {
    const cli = /^Updated to Very Happy (\S+) \(/.exec(message);
    if (cli) return { agent: null, version: cli[1] };
    const agent = /^Updated (\S+) to (\S+) \(/.exec(message);
    if (agent) return { agent: agent[1], version: agent[2] };
    return null;
}
