/**
 * B-587 — idle agent hibernation: the pure rules (spec
 * `specs/2026-10-idle-agent-hibernation.md`).
 *
 * Split of duties: the WRAPPER knows its own state (input queue, pending
 * approvals, last activity), the DAEMON knows machine policy (setting, Teams,
 * Automations, its own turn/background leases). The wrapper asks
 * (`/session-hibernate-check`), the daemon decides, the wrapper re-checks its
 * own state with `evaluateWrapperIdle` at the moment it commits. Every rule
 * fails closed: anything unknown means "stay awake".
 *
 * The two-sample signature confirmation is adapted from Orca's
 * `agent-hibernation-confirmation.ts` (MIT).
 */

/** Session capability: this wrapper checks in and can hibernate (AGENTS #14). */
export const HIBERNATION_CAPABILITY = 'agent-hibernation-v1';

export const HOUR_MS = 60 * 60 * 1000;
/** Default machine policy when settings say nothing. */
export const DEFAULT_HIBERNATION_IDLE_MS = 6 * HOUR_MS;
/** Range the web setting offers (env overrides may go lower, for tests). */
export const MIN_SETTING_IDLE_MS = HOUR_MS;
export const MAX_SETTING_IDLE_MS = 24 * HOUR_MS;
/** Wrapper sampling period. */
export const DEFAULT_HIBERNATION_CHECK_MS = 5 * 60 * 1000;
/** Old daemon (404) or daemon unreachable: try again much later. */
export const HIBERNATION_UNSUPPORTED_BACKOFF_MS = 30 * 60 * 1000;
/** Retention of a hibernated session's restore record (normal: 14 days). */
export const HIBERNATED_RECORD_MAX_AGE_MS = 90 * 24 * HOUR_MS;
/** web: a hibernation stamp older than the session's last heartbeat by more than this is stale. */
export const HIBERNATION_STAMP_SLACK_MS = 5 * 60 * 1000;

export const HIBERNATABLE_FLAVORS: readonly string[] = ['claude', 'codex'];
/** Origin tags that mark a session as owned by a machine process, not the UI. */
export const NON_UI_ORIGIN_TAGS: readonly string[] = ['teams', 'automation', 'assistant'];

export type HibernationRefusal =
    | 'disabled'
    | 'not-ui-session'
    | 'unsupported-flavor'
    | 'not-resumable'
    | 'not-tracked'
    | 'keep-awake'
    | 'turn-active'
    | 'queued-input'
    | 'pending-request'
    | 'background-tasks'
    | 'scheduled-wakeup'
    | 'recent-activity'
    | 'teams'
    | 'spawn-origin'
    | 'automation-bound'
    | 'automations-unknown'
    | 'unconfirmed'
    | 'busy'
    | 'exiting';

export type HibernationVerdict = { ok: true } | { ok: false; reason: HibernationRefusal };

// ── Policy ──────────────────────────────────────────────────────────────────

/** Machine setting: undefined = default (6h), 0 = off, else clamped to the web range. */
export function settingIdleMs(setting: unknown): number {
    if (setting === undefined || setting === null) return DEFAULT_HIBERNATION_IDLE_MS;
    if (typeof setting !== 'number' || !Number.isFinite(setting)) return DEFAULT_HIBERNATION_IDLE_MS;
    if (setting <= 0) return 0;
    return Math.min(MAX_SETTING_IDLE_MS, Math.max(MIN_SETTING_IDLE_MS, Math.round(setting)));
}

/** Effective idle threshold: `HAPPY_HIBERNATE_IDLE_MS` (any value ≥ 0, tests) wins over the setting. */
export function resolveIdleMs(setting: unknown, env: Record<string, string | undefined> = process.env): number {
    const raw = env.HAPPY_HIBERNATE_IDLE_MS;
    if (raw !== undefined && raw.trim() !== '') {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) return Math.round(value);
    }
    return settingIdleMs(setting);
}

/** Wrapper check period: `HAPPY_HIBERNATE_CHECK_MS` (≥ 1s) or the default. */
export function resolveCheckMs(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.HAPPY_HIBERNATE_CHECK_MS);
    if (Number.isFinite(value) && value >= 1000) return Math.round(value);
    return DEFAULT_HIBERNATION_CHECK_MS;
}

// ── Wrapper side ────────────────────────────────────────────────────────────

/** What the wrapper knows about itself; also the check-in body. */
export interface WrapperIdleSnapshot {
    flavor: string;
    /** The agent conversation id the web's resume needs (claudeSessionId / codexThreadId) is known. */
    resumable: boolean;
    /** Daemon-spawned, remote (UI) session; never a user's own terminal. */
    uiSession: boolean;
    variant?: string;
    /** `HAPPY_SPAWNED_BY` of this process (teams / automation / assistant / IM bridge …). */
    spawnedBy?: string;
    tags?: string[];
    /** Effective (latched) keep-awake — see `latchKeepAwake`. */
    keepAwake: boolean;
    /** Raw `metadata.keepAwake` as read now: true / false (explicit off) / undefined (absent). */
    keepAwakeSetting?: boolean;
    thinking: boolean;
    /** Items in the in-memory input queue, plus 1 when the server prompt queue holds some. */
    queuedInputs: number;
    /** The runner is parked waiting for the next message (turn fully over). */
    waitingForInput: boolean;
    pendingRequests: number;
    backgroundTasks: number;
    /** CronCreate / ScheduleWakeup still pending inside the agent process (review P3-4). Absent = 0. */
    scheduledWakeups?: number;
    lastActivityAt: number;
    /** Cleanup already running for another reason. */
    exiting?: boolean;
    /** B-852 (Codex): the agent CLI version this wrapper's app-server started with. */
    agentVersion?: string;
}

/** The wrapper-owned half of the rules; re-run at commit time. */
export function evaluateWrapperIdle(snapshot: WrapperIdleSnapshot, idleMs: number, now: number): HibernationVerdict {
    if (!(idleMs > 0)) return { ok: false, reason: 'disabled' };
    if (snapshot.exiting) return { ok: false, reason: 'exiting' };
    if (!snapshot.uiSession || snapshot.variant) return { ok: false, reason: 'not-ui-session' };
    if (!HIBERNATABLE_FLAVORS.includes(snapshot.flavor)) return { ok: false, reason: 'unsupported-flavor' };
    // The web can only wake what `resume-happy-session` can resume (restoreEligibility: no-backend-id).
    if (!snapshot.resumable) return { ok: false, reason: 'not-resumable' };
    if (snapshot.spawnedBy && snapshot.spawnedBy.trim()) return { ok: false, reason: 'spawn-origin' };
    if ((snapshot.tags ?? []).some((tag) => NON_UI_ORIGIN_TAGS.includes(tag))) return { ok: false, reason: 'spawn-origin' };
    if (snapshot.keepAwake) return { ok: false, reason: 'keep-awake' };
    if (snapshot.thinking) return { ok: false, reason: 'turn-active' };
    if (snapshot.queuedInputs > 0 || !snapshot.waitingForInput) return { ok: false, reason: 'queued-input' };
    if (snapshot.pendingRequests > 0) return { ok: false, reason: 'pending-request' };
    if (snapshot.backgroundTasks > 0) return { ok: false, reason: 'background-tasks' };
    if ((snapshot.scheduledWakeups ?? 0) > 0) return { ok: false, reason: 'scheduled-wakeup' };
    if (!(now - snapshot.lastActivityAt >= idleMs)) return { ok: false, reason: 'recent-activity' };
    return { ok: true };
}

/**
 * B-852: nothing is happening in this wrapper right now — the part of the
 * idle rules that does not depend on hibernation policy (origin, keep-awake,
 * flavor, resumability, time). The daemon's auto-restart decides the rest.
 */
export function isQuiescent(snapshot: WrapperIdleSnapshot): boolean {
    return !snapshot.exiting
        && snapshot.uiSession
        && !snapshot.variant
        && !snapshot.thinking
        && snapshot.queuedInputs === 0
        && snapshot.waitingForInput
        && snapshot.pendingRequests === 0
        && snapshot.backgroundTasks === 0
        && (snapshot.scheduledWakeups ?? 0) === 0;
}

/**
 * keepAwake survives an old web stripping it. An old web's metadata write
 * drops undeclared keys, so ABSENT does not mean "off": only an explicit
 * `false` (what the new web writes) turns a latched `true` off.
 */
export function latchKeepAwake(raw: unknown, latched: boolean): boolean {
    if (raw === true) return true;
    if (raw === false) return false;
    return latched;
}

// ── Daemon side ─────────────────────────────────────────────────────────────

export interface DaemonHibernationInput {
    idleMs: number;
    now: number;
    sessionId: string;
    pid: number;
    report: WrapperIdleSnapshot;
    /** The daemon tracks a live wrapper with this pid for this session. */
    trackedLive: boolean;
    trackedSpawnedBy?: string;
    teamsMember: boolean;
    turnActive: boolean;
    backgroundTasks: number;
    /** Session ids Automations reuse (send targets + sticky bindings); null = unknown. */
    automationBound: ReadonlySet<string> | null;
    /** Signature this session reported last time (two-sample confirmation). */
    previousSignature?: string;
    /** Another hibernation is in flight on this machine. */
    hibernationInFlight: boolean;
}

export function reportSignature(report: WrapperIdleSnapshot): string {
    return [report.flavor, report.lastActivityAt, report.keepAwake ? 1 : 0, report.pendingRequests, report.backgroundTasks].join('|');
}

export function decideDaemonHibernation(input: DaemonHibernationInput): HibernationVerdict {
    const { report } = input;
    if (!(input.idleMs > 0)) return { ok: false, reason: 'disabled' };
    if (!input.trackedLive) return { ok: false, reason: 'not-tracked' };
    if (input.teamsMember || input.trackedSpawnedBy === 'teams') return { ok: false, reason: 'teams' };
    if (input.trackedSpawnedBy && input.trackedSpawnedBy.trim()) return { ok: false, reason: 'spawn-origin' };
    const local = evaluateWrapperIdle(report, input.idleMs, input.now);
    if (!local.ok) return local;
    if (input.turnActive) return { ok: false, reason: 'turn-active' };
    if (input.backgroundTasks > 0) return { ok: false, reason: 'background-tasks' };
    if (input.automationBound === null) return { ok: false, reason: 'automations-unknown' };
    if (input.automationBound.has(input.sessionId)) return { ok: false, reason: 'automation-bound' };
    if (input.previousSignature !== reportSignature(report)) return { ok: false, reason: 'unconfirmed' };
    if (input.hibernationInFlight) return { ok: false, reason: 'busy' };
    return { ok: true };
}

/** When to ask again after a refusal (never sooner than the check period). */
export function nextCheckDelay(verdict: HibernationVerdict, report: Pick<WrapperIdleSnapshot, 'lastActivityAt'>, idleMs: number, checkMs: number, now: number): number {
    if (verdict.ok) return checkMs;
    if (verdict.reason === 'disabled') return Math.max(checkMs, HIBERNATION_UNSUPPORTED_BACKOFF_MS);
    if (verdict.reason === 'recent-activity') return Math.max(checkMs, report.lastActivityAt + idleMs - now);
    return checkMs;
}

// ── Stamp & wake ────────────────────────────────────────────────────────────

/** Written into session metadata by the hibernating wrapper. */
export interface HibernationStamp {
    at: number;
    /** The wrapper's message cursor at commit: everything after it is replayed on wake. */
    seq: number;
    idleMs: number;
    v: 1;
}

export function readHibernationStamp(metadata: unknown): HibernationStamp | null {
    const raw = (metadata as { hibernation?: unknown } | null | undefined)?.hibernation;
    if (!raw || typeof raw !== 'object') return null;
    const stamp = raw as Partial<HibernationStamp>;
    if (typeof stamp.at !== 'number' || typeof stamp.seq !== 'number' || !Number.isInteger(stamp.seq) || stamp.seq < 0) return null;
    return { at: stamp.at, seq: stamp.seq, idleMs: typeof stamp.idleMs === 'number' ? stamp.idleMs : 0, v: 1 };
}

/**
 * Wake from hibernation: the message cursor to start from. Returns the stamp's
 * seq when records arrived after it (replay them), null otherwise (keep the
 * server cursor). A stamp AHEAD of the server cursor is corrupt → ignore.
 */
export function hibernationReplaySeq(metadata: unknown, serverSeq: number): number | null {
    const stamp = readHibernationStamp(metadata);
    if (!stamp) return null;
    if (stamp.seq >= serverSeq) return null;
    return stamp.seq;
}
