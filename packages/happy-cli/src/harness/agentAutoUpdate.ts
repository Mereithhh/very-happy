/**
 * B-894 — 「自动更新 agent」: with the owner's per-machine switch on (default
 * OFF), the daemon updates an outdated Codex CLI through the same B-719
 * harness installer the machine page's Update button uses.
 *
 * - Only when `daemonState.agentVersions` (fresh, this daemon) says
 *   `update-available`, no Codex session has a turn in flight and no install /
 *   CLI update is running. Idle Codex sessions are then moved onto the new
 *   binary by the existing B-852 agent-version auto-restart.
 * - Never an endless loop: at most MAX_ATTEMPTS installs per target version
 *   (a refusal that is not transient counts), BACKOFF_MS between them, and
 *   none after one succeeded (the version check still says outdated = the
 *   new binary is not the one on PATH). The last outcome is published so the
 *   Web shows a failure instead of silently retrying.
 * - Attempts, backoff and the last outcome survive daemon restarts / handovers
 *   (agentAutoUpdateStore, B-894c); they are per target, so a new release
 *   starts from zero. An install cut off by the restart counts as a failure.
 * - Claude is not here: Web/remote sessions run the SDK binary bundled with
 *   the CLI, which moves with CLI releases.
 */
import type { AgentVersions, HarnessInstallId, HarnessInstallState } from '@slopus/happy-wire';
import type { HarnessInstallRequestResult } from './harnessInstaller';
import type { AgentAutoUpdatePersisted } from './agentAutoUpdateStore';

export const AGENT_AUTO_UPDATE_HARNESSES: readonly HarnessInstallId[] = ['codex'];
export const AGENT_AUTO_UPDATE_MAX_ATTEMPTS = 2;
export const AGENT_AUTO_UPDATE_BACKOFF_MS = 30 * 60 * 1000;
/** A version snapshot older than this is not trusted to start an install. */
export const AGENT_AUTO_UPDATE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Refusals that only mean "not now": retried on a later tick without counting. */
const TRANSIENT_REFUSALS = new Set(['install_in_progress', 'cli_update_in_progress']);

export type AgentAutoUpdateSkip =
    | 'disabled' | 'no-versions' | 'current' | 'turn-active' | 'installer-busy'
    | 'backoff' | 'gave-up' | 'still-outdated';

export interface AgentAutoUpdateAttempt {
    target: string;
    attempts: number;
    lastAt: number;
    succeeded?: boolean;
    detail?: string;
}

export type AgentAutoUpdateDecision =
    | { action: 'install'; harness: HarnessInstallId; from: string | null; target: string }
    | { action: 'skip'; harness: HarnessInstallId; reason: AgentAutoUpdateSkip; target?: string };

/** Pure: what to do for one harness right now. */
export function decideAgentAutoUpdate(input: {
    harness: HarnessInstallId;
    enabled: boolean;
    versions: AgentVersions | null;
    turnActive: boolean;
    installerBusy: boolean;
    attempt: AgentAutoUpdateAttempt | undefined;
    now: number;
}): AgentAutoUpdateDecision {
    const { harness } = input;
    if (!input.enabled) return { action: 'skip', harness, reason: 'disabled' };
    const versions = input.versions;
    if (!versions || input.now - versions.checkedAt > AGENT_AUTO_UPDATE_SNAPSHOT_MAX_AGE_MS) return { action: 'skip', harness, reason: 'no-versions' };
    const agent = versions.agents.find((a) => a.id === harness);
    if (!agent || agent.status !== 'update-available' || !agent.latest) return { action: 'skip', harness, reason: 'current' };
    const target = agent.latest;
    const attempt = input.attempt?.target === target ? input.attempt : undefined;
    if (attempt?.succeeded) return { action: 'skip', harness, reason: 'still-outdated', target };
    if (attempt && attempt.attempts >= AGENT_AUTO_UPDATE_MAX_ATTEMPTS) return { action: 'skip', harness, reason: 'gave-up', target };
    if (attempt && input.now - attempt.lastAt < AGENT_AUTO_UPDATE_BACKOFF_MS) return { action: 'skip', harness, reason: 'backoff', target };
    if (input.turnActive) return { action: 'skip', harness, reason: 'turn-active', target };
    if (input.installerBusy) return { action: 'skip', harness, reason: 'installer-busy', target };
    return { action: 'install', harness, from: agent.installed, target };
}

/** Published in `daemonState.agentAutoUpdate`; `rpcAvailable` + `detectedAt` = the capability (same rule as autoRestart). */
export interface AgentAutoUpdateStatus {
    harness: HarnessInstallId;
    target: string;
    /** installing → installed | failed; gave-up = no more automatic attempts for this target. */
    state: 'installing' | 'installed' | 'failed' | 'gave-up';
    detail?: string;
    attempts: number;
    at: number;
}

export function createAgentAutoUpdater(deps: {
    enabled: () => boolean;
    versions: () => AgentVersions | null;
    /** A session of this harness's flavor has a turn in flight. */
    turnActive: (harness: HarnessInstallId) => boolean;
    installerBusy: () => boolean;
    request: (harness: HarnessInstallId) => Promise<HarnessInstallRequestResult>;
    publish: (status: Record<string, AgentAutoUpdateStatus>) => void;
    log: (message: string) => void;
    now?: () => number;
    /** Persisted state across daemon restarts (B-894c); omitted = memory only. */
    store?: { read: () => AgentAutoUpdatePersisted; write: (state: AgentAutoUpdatePersisted) => void };
}) {
    const now = deps.now ?? Date.now;
    const loaded = deps.store?.read() ?? { attempts: {}, statuses: {} };
    const attempts = new Map<HarnessInstallId, AgentAutoUpdateAttempt>(
        Object.entries(loaded.attempts).map(([harness, attempt]) => [harness as HarnessInstallId, attempt]));
    const statuses: Record<string, AgentAutoUpdateStatus> = { ...loaded.statuses };
    const save = () => {
        try {
            deps.store?.write({ attempts: Object.fromEntries(attempts), statuses: { ...statuses } });
        } catch (error) {
            deps.log(`[AGENT AUTO-UPDATE] could not save state: ${String(error)}`);
        }
    };
    // An install the previous daemon was waiting on never reported back: a failed attempt, not a live one.
    for (const status of Object.values(statuses)) {
        if (status.state !== 'installing') continue;
        const attempt = attempts.get(status.harness);
        if (attempt?.target === status.target) attempt.detail = 'interrupted_by_daemon_restart';
        statuses[status.harness] = {
            ...status,
            state: status.attempts >= AGENT_AUTO_UPDATE_MAX_ATTEMPTS ? 'gave-up' : 'failed',
            detail: 'interrupted_by_daemon_restart',
        };
    }
    if (Object.keys(statuses).length > 0) {
        save();
        deps.publish({ ...statuses });
    }
    /** The install this updater started and is waiting on (harness-install publishes the outcome). */
    let pending: { harness: HarnessInstallId; target: string } | null = null;
    let ticking = false;

    const setStatus = (status: AgentAutoUpdateStatus) => {
        statuses[status.harness] = status;
        save();
        deps.publish({ ...statuses });
    };
    const fail = (harness: HarnessInstallId, target: string, detail: string) => {
        const attempt = attempts.get(harness)!;
        attempt.detail = detail;
        const gaveUp = attempt.attempts >= AGENT_AUTO_UPDATE_MAX_ATTEMPTS;
        deps.log(`[AGENT AUTO-UPDATE] ${harness} → ${target} failed (attempt ${attempt.attempts}): ${detail}${gaveUp ? '; giving up on this version' : ''}`);
        setStatus({ harness, target, state: gaveUp ? 'gave-up' : 'failed', detail, attempts: attempt.attempts, at: now() });
    };

    async function tick(): Promise<void> {
        if (ticking || pending) return;
        ticking = true;
        try {
            for (const harness of AGENT_AUTO_UPDATE_HARNESSES) {
                const decision = decideAgentAutoUpdate({
                    harness,
                    enabled: deps.enabled(),
                    versions: deps.versions(),
                    turnActive: deps.turnActive(harness),
                    installerBusy: deps.installerBusy(),
                    attempt: attempts.get(harness),
                    now: now(),
                });
                if (decision.action !== 'install') {
                    // A successful install whose re-check still says outdated is a failure the owner must see.
                    const status = statuses[harness];
                    if (decision.reason === 'still-outdated' && status?.state === 'installed' && status.target === decision.target) {
                        const attempt = attempts.get(harness)!;
                        attempt.attempts = AGENT_AUTO_UPDATE_MAX_ATTEMPTS;
                        fail(harness, decision.target!, 'still_outdated_after_install');
                    }
                    continue;
                }
                const prior = attempts.get(harness);
                const attempt: AgentAutoUpdateAttempt = prior?.target === decision.target
                    ? { ...prior, attempts: prior.attempts + 1, lastAt: now() }
                    : { target: decision.target, attempts: 1, lastAt: now() };
                attempts.set(harness, attempt);
                deps.log(`[AGENT AUTO-UPDATE] ${harness} ${decision.from ?? '?'} → ${decision.target} (attempt ${attempt.attempts})`);
                pending = { harness, target: decision.target };
                setStatus({ harness, target: decision.target, state: 'installing', attempts: attempt.attempts, at: now() });
                const result = await deps.request(harness).catch((error): HarnessInstallRequestResult => ({ error: `request_failed: ${String(error)}` }));
                if ('accepted' in result) return; // outcome arrives through onInstallState
                pending = null;
                if (TRANSIENT_REFUSALS.has(result.error)) {
                    // Not an attempt: undo the count and try on a later tick.
                    if (prior?.target === decision.target) attempts.set(harness, prior); else attempts.delete(harness);
                    const before = statuses[harness];
                    delete statuses[harness];
                    save();
                    if (before) deps.publish({ ...statuses });
                    continue;
                }
                fail(harness, decision.target, result.error);
            }
        } finally {
            ticking = false;
        }
    }

    /** Fed every daemonState.harnessInstall publish; only the install this updater started counts. */
    function onInstallState(state: HarnessInstallState): void {
        if (!pending || state.harness !== pending.harness || state.state === 'installing') return;
        const { harness, target } = pending;
        pending = null;
        const attempt = attempts.get(harness);
        if (!attempt) return;
        if (state.state === 'installed') {
            attempt.succeeded = true;
            deps.log(`[AGENT AUTO-UPDATE] ${harness} → ${target} installed`);
            setStatus({ harness, target, state: 'installed', attempts: attempt.attempts, at: now() });
        } else {
            fail(harness, target, state.detail ?? 'unknown');
        }
    }

    return { tick, onInstallState, statuses: () => ({ ...statuses }) };
}

export const AGENT_AUTO_UPDATE_TICK_MS = 5 * 60 * 1000;
/** `HAPPY_AGENT_AUTO_UPDATE_TICK_MS` (≥ 1000, tests) or the default; the version check also triggers a tick. */
export function resolveAgentAutoUpdateTickMs(raw: string | undefined): number {
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 1000 ? value : AGENT_AUTO_UPDATE_TICK_MS;
}
