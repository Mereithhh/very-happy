/**
 * B-852 — restart a session whose wrapper still runs older code than the
 * daemon, automatically, once it is provably safe: the pure rules (spec
 * `specs/2026-10-auto-restart-stale-wrappers.md`).
 *
 * The proof is the wrapper's own idle check-in (B-587 `WrapperIdleSnapshot`),
 * taken the moment it arrives; the daemon adds what only it knows (turn and
 * background leases, Automations runs, the conversation on disk, its own
 * pacing). Every rule fails closed: anything unknown means "not now".
 */
import { compareExactVersions } from './cliUpdate';
import type { WrapperIdleSnapshot } from '@/hibernation/hibernationPolicy';

/** Session capability: this wrapper reports quiescence whatever its spawn origin (teams, automation, pi). */
export const AUTO_RESTART_CAPABILITY = 'auto-restart-v1';

/** §2 condition 6 — no user input or agent activity for this long. */
export const AUTO_RESTART_QUIET_MS = 10 * 60 * 1000;
/**
 * §1 — the daemon never lets a wrapper sleep its check-in longer than this
 * while the switch is on, so after the NEXT upgrade every wrapper is looked
 * at within minutes (hibernation alone may schedule hours ahead).
 */
export const AUTO_RESTART_RECHECK_CAP_MS = 10 * 60 * 1000;

/** `HAPPY_AUTO_RESTART_QUIET_MS` (any value ≥ 0, tests) or the default. */
export function resolveQuietMs(env: Record<string, string | undefined> = process.env): number {
    const raw = env.HAPPY_AUTO_RESTART_QUIET_MS;
    if (raw !== undefined && raw.trim() !== '') {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) return Math.round(value);
    }
    return AUTO_RESTART_QUIET_MS;
}
/** §3 — at most this many automatic restarts at once on one machine … */
export const AUTO_RESTART_MAX_CONCURRENT = 1;
/** … and at least this long between two of them. */
export const AUTO_RESTART_MIN_GAP_MS = 15_000;
/** §3 — attempts per (session, target version); after the last failure it is left to the user. */
export const AUTO_RESTART_MAX_ATTEMPTS = 2;
/** §3 — wait after a failed attempt before the next one. */
export const AUTO_RESTART_BACKOFF_MS = 10 * 60 * 1000;
/** Floor for any `nextCheckMs` we hand back (the probe clamps to 1 s anyway). */
export const AUTO_RESTART_MIN_CHECK_MS = 15_000;

/** Flavors whose `restart-session` reopens the same agent conversation (§2 condition 8). */
export const AUTO_RESTART_FLAVORS: readonly string[] = ['claude', 'codex', 'acp'];

export type AutoRestartRefusal =
    | 'disabled'
    | 'not-stale'
    | 'not-tracked'
    | 'exiting'
    | 'local-terminal'
    | 'assistant'
    | 'unsupported-flavor'
    | 'not-resumable'
    | 'turn-active'
    | 'pending-request'
    | 'queued-input'
    | 'background-tasks'
    | 'scheduled-wakeup'
    | 'recent-activity'
    | 'automation-running'
    | 'backoff'
    | 'gave-up'
    | 'machine-busy';

export type AutoRestartVerdict = { ok: true } | { ok: false; reason: AutoRestartRefusal };

/** Why a wrapper is behind: its own CLI code, or (Codex) the agent binary it started with. */
export type StaleKind = 'cli' | 'agent';

export interface Staleness {
    kind: StaleKind;
    /** What it runs now. */
    from: string;
    /** What a restart lands on. */
    target: string;
}

/**
 * §2 condition 0. The wrapper's CLI version against the daemon's; for Codex
 * also the agent version it started with against the installed one. An
 * unparsable version is never "behind".
 */
export function wrapperStaleness(input: {
    wrapperVersion: string | null | undefined;
    daemonVersion: string;
    agentVersion?: string | null;
    installedAgentVersion?: string | null;
}): Staleness | null {
    const wrapper = input.wrapperVersion?.trim();
    if (wrapper) {
        const cmp = compareExactVersions(wrapper, input.daemonVersion);
        if (cmp !== null && cmp < 0) return { kind: 'cli', from: wrapper, target: input.daemonVersion };
    }
    const running = input.agentVersion?.trim();
    const installed = input.installedAgentVersion?.trim();
    if (running && installed) {
        const cmp = compareExactVersions(running, installed);
        if (cmp !== null && cmp < 0) return { kind: 'agent', from: running, target: installed };
    }
    return null;
}

/** Per (session, target) bookkeeping kept by the scheduler. */
export interface AttemptRecord {
    target: string;
    attempts: number;
    /** No new attempt before this. */
    notBefore: number;
    lastError?: string;
}

export interface AutoRestartInput {
    enabled: boolean;
    now: number;
    /** Condition 6 threshold (default AUTO_RESTART_QUIET_MS). */
    quietMs?: number;
    staleness: Staleness | null;
    /** The daemon tracks a live wrapper with this pid for this session. */
    trackedLive: boolean;
    report: WrapperIdleSnapshot;
    /** Daemon-side leases (B-466 / B-507). */
    turnActive: boolean;
    backgroundTasks: number;
    /** An Automations run is in flight on this session. */
    automationRunning: boolean;
    /** `resumePrecheck` passed: the restart reopens this conversation. */
    resumable: boolean;
    attempt: AttemptRecord | null;
    /** Automatic restarts running right now / when the last one started. */
    inFlight: number;
    lastStartedAt: number | null;
}

/**
 * Spec §2 — every condition, in order. Cheap, wrapper-reported facts first;
 * pacing last, so a refusal names the real blocker rather than "busy".
 */
export function decideAutoRestart(input: AutoRestartInput): AutoRestartVerdict {
    const { report } = input;
    if (!input.enabled) return { ok: false, reason: 'disabled' };
    if (!input.staleness) return { ok: false, reason: 'not-stale' };
    if (!input.trackedLive) return { ok: false, reason: 'not-tracked' };
    if (report.exiting) return { ok: false, reason: 'exiting' };
    // 4: never the user's own terminal (local mode / controlledByUser / not daemon-spawned).
    if (!report.uiSession) return { ok: false, reason: 'local-terminal' };
    if (report.variant) return { ok: false, reason: 'assistant' };
    // 8: only agents whose restart reopens the same conversation.
    if (!AUTO_RESTART_FLAVORS.includes(report.flavor)) return { ok: false, reason: 'unsupported-flavor' };
    if (!input.resumable) return { ok: false, reason: 'not-resumable' };
    // 1: no turn in flight (wrapper flag and daemon lease).
    if (report.thinking || input.turnActive) return { ok: false, reason: 'turn-active' };
    // 2: no pending permission request / question.
    if (report.pendingRequests > 0) return { ok: false, reason: 'pending-request' };
    // 3: input queue empty and the runner parked on the next message.
    if (report.queuedInputs > 0 || !report.waitingForInput) return { ok: false, reason: 'queued-input' };
    // 5: no background shell / sub-agent / scheduled wakeup.
    if (report.backgroundTasks > 0 || input.backgroundTasks > 0) return { ok: false, reason: 'background-tasks' };
    if ((report.scheduledWakeups ?? 0) > 0) return { ok: false, reason: 'scheduled-wakeup' };
    // 6: nobody touched it for N minutes.
    if (!(input.now - report.lastActivityAt >= (input.quietMs ?? AUTO_RESTART_QUIET_MS))) return { ok: false, reason: 'recent-activity' };
    // 7: an Automations run in flight would fail with session_exited.
    if (input.automationRunning) return { ok: false, reason: 'automation-running' };
    // 11: failure backoff, give-up.
    const attempt = input.attempt && input.attempt.target === input.staleness.target ? input.attempt : null;
    if (attempt && attempt.attempts >= AUTO_RESTART_MAX_ATTEMPTS) return { ok: false, reason: 'gave-up' };
    if (attempt && input.now < attempt.notBefore) return { ok: false, reason: 'backoff' };
    // 10: machine pacing.
    if (input.inFlight >= AUTO_RESTART_MAX_CONCURRENT) return { ok: false, reason: 'machine-busy' };
    if (input.lastStartedAt !== null && input.now - input.lastStartedAt < AUTO_RESTART_MIN_GAP_MS) return { ok: false, reason: 'machine-busy' };
    return { ok: true };
}

/**
 * When the wrapper should check in again for this session's restart; null
 * when auto-restart has nothing to wait for (the hibernation cadence rules).
 * `jitter` ∈ [0, 1) spreads a burst of busy refusals.
 */
export function autoRestartNextCheck(verdict: AutoRestartVerdict, input: Pick<AutoRestartInput, 'now' | 'report' | 'attempt' | 'lastStartedAt' | 'quietMs'>, jitter = 0): number | null {
    if (verdict.ok) return null;
    switch (verdict.reason) {
        case 'recent-activity':
            return Math.max(AUTO_RESTART_MIN_CHECK_MS, input.report.lastActivityAt + (input.quietMs ?? AUTO_RESTART_QUIET_MS) - input.now);
        case 'machine-busy':
            return AUTO_RESTART_MIN_GAP_MS + Math.round(Math.min(Math.max(jitter, 0), 0.999) * 2 * AUTO_RESTART_MIN_GAP_MS);
        case 'backoff':
            return Math.max(AUTO_RESTART_MIN_CHECK_MS, (input.attempt?.notBefore ?? input.now) - input.now);
        default:
            return null;
    }
}

/** Record a finished attempt. Success clears it (the wrapper is no longer behind). */
export function recordAttempt(previous: AttemptRecord | null, target: string, ok: boolean, now: number, error?: string): AttemptRecord | null {
    if (ok) return null;
    const attempts = (previous && previous.target === target ? previous.attempts : 0) + 1;
    return { target, attempts, notBefore: now + AUTO_RESTART_BACKOFF_MS * attempts, ...(error ? { lastError: error } : {}) };
}

/** What the daemon publishes per behind session (spec §4). */
export type AutoRestartSessionState = 'waiting' | 'restarting' | 'failed' | 'manual';

export interface AutoRestartSessionStatus {
    state: AutoRestartSessionState;
    reason?: string;
    since: number;
    target: string;
}

/** Refusals that will never clear on their own for this wrapper: hand it to the user now. */
const MANUAL_REASONS: ReadonlySet<AutoRestartRefusal> = new Set(['local-terminal', 'assistant', 'unsupported-flavor', 'not-resumable']);

export function statusFromVerdict(verdict: AutoRestartVerdict, previous: AutoRestartSessionStatus | undefined, staleness: Staleness, now: number, attempt: AttemptRecord | null): AutoRestartSessionStatus | null {
    if (verdict.ok) return null;
    if (verdict.reason === 'disabled' || verdict.reason === 'not-stale' || verdict.reason === 'not-tracked') return null;
    const since = previous && previous.target === staleness.target ? previous.since : now;
    if (verdict.reason === 'gave-up') {
        return { state: 'failed', reason: attempt?.lastError ?? 'gave-up', since, target: staleness.target };
    }
    return {
        state: MANUAL_REASONS.has(verdict.reason) ? 'manual' : 'waiting',
        reason: verdict.reason,
        since,
        target: staleness.target,
    };
}

/**
 * A wrapper that never checks in can never be proven idle (spec §1): B-587
 * check-ins exist only in UI Claude/Codex wrappers, and before this version
 * only for sessions without a spawn origin.
 */
export function wrapperReportsIdle(input: {
    flavor: string | null | undefined;
    capabilities: readonly string[] | null | undefined;
    spawnedBy?: string | null;
    tags?: readonly string[] | null;
    variant?: string | null;
}): boolean {
    const caps = input.capabilities ?? [];
    if (input.variant) return false;
    if (caps.includes(AUTO_RESTART_CAPABILITY)) return true;
    if (!caps.includes('agent-hibernation-v1')) return false;
    if (input.flavor !== 'claude' && input.flavor !== 'codex') return false;
    if (input.spawnedBy && input.spawnedBy.trim()) return false;
    return !(input.tags ?? []).some((tag) => tag === 'teams' || tag === 'automation' || tag === 'assistant');
}

/** The service line the restarted wrapper posts (spec §5); the web localizes it by `kind`. */
export const AUTO_UPDATED_EVENT_KIND = 'session-auto-updated';

/** Env the daemon hands an automatically restarted wrapper: `<StaleKind>:<target version>`. */
export const AUTO_RESTARTED_ENV = 'HAPPY_AUTO_RESTARTED';

export function encodeAutoRestarted(kind: StaleKind, target: string): string {
    return `${kind}:${target}`;
}

export function decodeAutoRestarted(raw: string | undefined): { kind: StaleKind; target: string } | null {
    const match = /^(cli|agent):(\S{1,64})$/.exec(raw?.trim() ?? '');
    return match ? { kind: match[1] as StaleKind, target: match[2] } : null;
}

/**
 * The event text (English; old webs show it verbatim). `agent` = the agent
 * CLI (Codex) was updated, not Very Happy.
 */
export function autoUpdatedEventText(kind: StaleKind, version: string, agentName = 'Codex'): string {
    return kind === 'agent'
        ? `Updated ${agentName} to ${version} (session restarted in place, history kept)`
        : `Updated to Very Happy ${version} (session restarted in place, history kept)`;
}

/**
 * Read (and remove, so it never leaks into the agent's own child processes)
 * the restart marker; returns the event to post, or null.
 */
export function takeAutoRestartedEvent(env: NodeJS.ProcessEnv, agentName?: string): { type: 'message'; kind: string; message: string } | null {
    const decoded = decodeAutoRestarted(env[AUTO_RESTARTED_ENV]);
    delete env[AUTO_RESTARTED_ENV];
    if (!decoded) return null;
    return { type: 'message', kind: AUTO_UPDATED_EVENT_KIND, message: autoUpdatedEventText(decoded.kind, decoded.target, agentName) };
}
