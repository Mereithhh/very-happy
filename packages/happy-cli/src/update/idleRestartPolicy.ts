/**
 * B-911 — rules for "restart this session once it is idle" (spec
 * `specs/2026-10-auto-restart-stale-wrappers.md` §B-911). Two callers queue
 * such a restart with the daemon:
 *
 * - the owner, from the 「需要我决策」 card a stale wrapper the daemon cannot
 *   restart by itself (`manual` / `no-report`, `no-check-in`) gets — the
 *   「本轮结束后重启」 button (RPC `restart-session` + `whenIdle`);
 * - the agent itself, with the `request_idle_restart` MCP tool (new wrappers
 *   only; it can restart nothing but its own session).
 *
 * A wrapper that never checks in can still be watched from the daemon: every
 * wrapper since 0.2.139 (B-466) posts `turn_started` (renewed every 60 s while
 * the turn runs) and `turn_ended`. So "idle" here = no live turn lease, no
 * background task or automation run, no upgrade queued, a quiet spell since
 * the last turn edge, and — so a turn that started before this daemon saw
 * anything has had time to renew its lease — either a `turn_ended` after the
 * request or one full observation window (> one lease) since it.
 *
 * Everything here is pure; `daemon/idleRestart.ts` holds the queue and effects.
 */
import { compareExactVersions } from './cliUpdate';

/** First CLI whose wrappers report turn edges to the daemon (B-466). Older ones can never be proven idle. */
export const TURN_REPORTING_MIN_VERSION = '0.2.139';
/** Quiet spell after the last turn edge (a queued message starts the next turn within it). */
export const IDLE_RESTART_QUIET_MS = 30_000;
/** > TURN_LEASE_MS (60 s): a turn already running when the request came in has renewed its lease by then. */
export const IDLE_RESTART_OBSERVE_MS = 90_000;
/** How often a queued restart is looked at (turn edges also trigger a look). */
export const IDLE_RESTART_CHECK_MS = 10_000;

/** Abuse limits for the agent's own requests (the owner's button is not limited beyond one pending at a time). */
export const AGENT_RESTART_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AGENT_RESTART_MAX_PER_WINDOW = 3;
/** Minimum time between two restarts of the same session (any source) before the agent may ask again. */
export const AGENT_RESTART_COOLDOWN_MS = 10 * 60 * 1000;
/** An agent request still waiting for idle after this long is dropped (the owner's never is). */
export const AGENT_RESTART_PENDING_TTL_MS = 6 * 60 * 60 * 1000;

export type IdleRestartSource = 'owner' | 'agent';

function envMs(env: Record<string, string | undefined>, key: string, fallback: number): number {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== '') {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) return Math.round(value);
    }
    return fallback;
}

/** Test knobs (`HAPPY_IDLE_RESTART_QUIET_MS` / `_OBSERVE_MS` / `_CHECK_MS`); the defaults otherwise. */
export function resolveIdleRestartTiming(env: Record<string, string | undefined> = process.env): { quietMs: number; observeMs: number; checkMs: number } {
    return {
        quietMs: envMs(env, 'HAPPY_IDLE_RESTART_QUIET_MS', IDLE_RESTART_QUIET_MS),
        observeMs: envMs(env, 'HAPPY_IDLE_RESTART_OBSERVE_MS', IDLE_RESTART_OBSERVE_MS),
        checkMs: Math.max(1_000, envMs(env, 'HAPPY_IDLE_RESTART_CHECK_MS', IDLE_RESTART_CHECK_MS)),
    };
}

/** Whether this wrapper version reports turn edges (unknown version → no). */
export function wrapperReportsTurns(wrapperVersion: string | null | undefined): boolean {
    if (!wrapperVersion) return false;
    const order = compareExactVersions(wrapperVersion, TURN_REPORTING_MIN_VERSION);
    return order !== null && order >= 0;
}

export type IdleRestartWait = 'turn-active' | 'background-tasks' | 'automation-run' | 'upgrade-pending' | 'quiet' | 'observing';

export function idleRestartReady(input: {
    now: number;
    requestedAt: number;
    turnActive: boolean;
    backgroundTasks: number;
    automationRunning: boolean;
    upgradePending: string | null;
    /** Last `turn_started` / `turn_ended` this daemon saw for the session (null = none). */
    lastTurnEventAt: number | null;
    /** Last `turn_ended` this daemon saw for the session (null = none). */
    lastTurnEndedAt: number | null;
    quietMs?: number;
    observeMs?: number;
}): { ready: true } | { ready: false; wait: IdleRestartWait } {
    if (input.turnActive) return { ready: false, wait: 'turn-active' };
    if (input.backgroundTasks > 0) return { ready: false, wait: 'background-tasks' };
    if (input.automationRunning) return { ready: false, wait: 'automation-run' };
    // B-856: the next daemon is about to take over; it restarts onto newer code (the queue is persisted).
    if (input.upgradePending) return { ready: false, wait: 'upgrade-pending' };
    if (input.lastTurnEventAt !== null && input.now - input.lastTurnEventAt < (input.quietMs ?? IDLE_RESTART_QUIET_MS)) return { ready: false, wait: 'quiet' };
    const endedSinceRequest = input.lastTurnEndedAt !== null && input.lastTurnEndedAt >= input.requestedAt;
    if (!endedSinceRequest && input.now - input.requestedAt < (input.observeMs ?? IDLE_RESTART_OBSERVE_MS)) return { ready: false, wait: 'observing' };
    return { ready: true };
}

export type AgentRestartRefusal =
    | { code: 'rate-limited'; retryAfterMs: number }
    | { code: 'cooldown'; retryAfterMs: number };

/**
 * The agent's own request: at most AGENT_RESTART_MAX_PER_WINDOW accepted per
 * rolling window, and none within AGENT_RESTART_COOLDOWN_MS of the session's
 * last restart. `accepted` = timestamps of earlier accepted agent requests.
 */
export function agentRestartRefusal(input: { now: number; accepted: readonly number[]; lastRestartAt: number | null }): AgentRestartRefusal | null {
    if (input.lastRestartAt !== null && input.now - input.lastRestartAt < AGENT_RESTART_COOLDOWN_MS) {
        return { code: 'cooldown', retryAfterMs: AGENT_RESTART_COOLDOWN_MS - (input.now - input.lastRestartAt) };
    }
    const recent = input.accepted.filter(at => input.now - at < AGENT_RESTART_WINDOW_MS).sort((a, b) => a - b);
    if (recent.length >= AGENT_RESTART_MAX_PER_WINDOW) {
        return { code: 'rate-limited', retryAfterMs: AGENT_RESTART_WINDOW_MS - (input.now - recent[recent.length - AGENT_RESTART_MAX_PER_WINDOW]) };
    }
    return null;
}

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_RE = /^[A-Za-z0-9._\-[\]:/]{1,128}$/;

/**
 * A wrapper older than B-849b (≤0.2.190) records no model / effort intent, so
 * a restart would fall back to the defaults (project log #21). What it really
 * runs is on its Claude Code child's command line (`--model=…`, `--effort=…`,
 * or the two-argument forms); the restart passes those on.
 */
export function claudeRunIntentFromArgv(argv: readonly string[]): { model?: string; effort?: string } {
    const out: { model?: string; effort?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        for (const flag of ['model', 'effort'] as const) {
            let value: string | undefined;
            if (arg === `--${flag}`) value = argv[i + 1];
            else if (arg.startsWith(`--${flag}=`)) value = arg.slice(flag.length + 3);
            if (value === undefined) continue;
            if (flag === 'model' && MODEL_RE.test(value)) out.model = value;
            if (flag === 'effort' && CLAUDE_EFFORTS.has(value)) out.effort = value;
        }
    }
    return out;
}

/** Env the daemon hands a restarted wrapper whose predecessor recorded no effort intent. */
export const RESTART_EFFORT_ENV = 'HAPPY_RESTART_EFFORT';

/** Read (and remove, so it never reaches the agent's children) the effort to keep; null = none / invalid. */
export function takeRestartEffort(env: NodeJS.ProcessEnv): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
    const raw = env[RESTART_EFFORT_ENV]?.trim();
    delete env[RESTART_EFFORT_ENV];
    return raw && CLAUDE_EFFORTS.has(raw) ? raw as 'low' | 'medium' | 'high' | 'xhigh' | 'max' : null;
}

/** The service line the wrapper posts after a restart the agent asked for (old webs show the text verbatim). */
export const RESTARTED_ON_REQUEST_EVENT_KIND = 'session-restarted-on-request';
export const RESTARTED_ON_REQUEST_ENV = 'HAPPY_RESTARTED_ON_REQUEST';
export function restartedOnRequestEventText(version: string): string {
    return `Restarted in place at the agent's request on Very Happy ${version} (history kept)`;
}
export function takeRestartedOnRequestEvent(env: NodeJS.ProcessEnv): { type: 'message'; kind: string; message: string } | null {
    const raw = env[RESTARTED_ON_REQUEST_ENV]?.trim();
    delete env[RESTARTED_ON_REQUEST_ENV];
    if (!raw || !/^\S{1,64}$/.test(raw)) return null;
    return { type: 'message', kind: RESTARTED_ON_REQUEST_EVENT_KIND, message: restartedOnRequestEventText(raw) };
}
