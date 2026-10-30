/**
 * B-852 — daemon side of automatic in-place restarts for wrappers left behind
 * by a CLI upgrade (spec `specs/2026-10-auto-restart-stale-wrappers.md`).
 *
 * Decides on each wrapper idle check-in (the only fresh proof of quiescence),
 * paces restarts machine-wide, backs off failures and publishes per-session
 * status for the web. Effects are injected; the rules are
 * `update/autoRestartPolicy.ts`.
 */
import {
    AUTO_RESTART_MAX_ATTEMPTS,
    AUTO_RESTART_MIN_GAP_MS,
    autoRestartNextCheck,
    decideAutoRestart,
    recordAttempt,
    statusFromVerdict,
    wrapperReportsIdle,
    wrapperStaleness,
    type AttemptRecord,
    type AutoRestartSessionStatus,
    type AutoRestartVerdict,
    type Staleness,
} from '@/update/autoRestartPolicy';
import type { WrapperIdleSnapshot } from '@/hibernation/hibernationPolicy';

export interface AutoRestartTracked {
    live: boolean;
    /** The wrapper's own CLI version (metadata.version). */
    wrapperVersion?: string | null;
    flavor?: string | null;
    capabilities?: readonly string[] | null;
    spawnedBy?: string | null;
    tags?: readonly string[] | null;
    variant?: string | null;
    /** metadata.startedBy: `terminal` = the user's own terminal, never restarted for them. */
    startedBy?: string | null;
}

export interface AutoRestartDeps {
    enabled: () => boolean;
    /** Condition 6 threshold (tests shorten it via HAPPY_AUTO_RESTART_QUIET_MS). */
    quietMs?: number;
    daemonVersion: string;
    /** Installed agent binary version for this flavor (Codex), from the daemon's agentVersions snapshot. */
    installedAgentVersion: (flavor: string) => string | null;
    tracked: (sessionId: string, pid: number) => AutoRestartTracked | null;
    /** Every live tracked session (for the sweep). */
    liveSessions: () => Array<{ sessionId: string } & AutoRestartTracked>;
    turnActive: (sessionId: string) => boolean;
    backgroundTasks: (sessionId: string) => number;
    automationRunning: (sessionId: string) => boolean;
    /** `resumePrecheck` against the conversation on disk. */
    /** `resumePrecheck` on the server's (authoritative) metadata against the conversation on disk. */
    resumable: (sessionId: string) => Promise<boolean>;
    restart: (sessionId: string, staleness: Staleness) => Promise<{ ok: true } | { ok: false; error: string }>;
    /**
     * The server's view of a session the failed restart left offline (null =
     * unknown). The retry only runs while it is still offline and unarchived:
     * nobody restored, archived or resumed it elsewhere meanwhile.
     */
    serverSession?: (sessionId: string) => Promise<{ active: boolean; archived: boolean } | null>;
    /** Timer for the offline retry (tests drive it by hand). */
    schedule?: (fn: () => void, ms: number) => void;
    publish: (sessions: Record<string, AutoRestartSessionStatus>) => void;
    now?: () => number;
    random?: () => number;
    log?: (message: string) => void;
}

export interface AutoRestartCheckIn {
    sessionId: string;
    pid: number;
    report: WrapperIdleSnapshot & { agentVersion?: string };
}

export function createAutoRestart(deps: AutoRestartDeps) {
    const now = () => (deps.now ?? Date.now)();
    const random = deps.random ?? Math.random;
    const statuses = new Map<string, AutoRestartSessionStatus>();
    const attempts = new Map<string, AttemptRecord>();
    /** Agent version each wrapper last reported (Codex), for the sweep. */
    const agentVersions = new Map<string, string>();
    /**
     * When each session was first seen behind (per target). Survives the
     * switch going off and on, so a toggle never restarts the long-wait clock.
     */
    const behindSince = new Map<string, { target: string; since: number }>();
    /**
     * Sessions a failed restart left with no wrapper (old one stopped, new one
     * never came up): they never check in again, so their status lives here
     * until the session is back online (spec §3 "offline failure").
     */
    const offline = new Map<string, Staleness>();
    const schedule = deps.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.(); });
    let inFlight = 0;
    let lastStartedAt: number | null = null;
    let publishedSignature = '';

    function publish(): void {
        const snapshot = Object.fromEntries([...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)));
        const signature = JSON.stringify(snapshot);
        if (signature === publishedSignature) return;
        publishedSignature = signature;
        deps.publish(snapshot);
    }

    function setStatus(sessionId: string, status: AutoRestartSessionStatus | null): void {
        if (!status) { statuses.delete(sessionId); return; }
        const clock = behindSince.get(sessionId);
        const since = clock && clock.target === status.target ? clock.since : status.since;
        behindSince.set(sessionId, { target: status.target, since });
        statuses.set(sessionId, { ...status, since });
    }

    /** Caught up or gone for good: drop every trace (the next upgrade starts afresh). */
    function clearSession(sessionId: string): void {
        statuses.delete(sessionId);
        behindSince.delete(sessionId);
        offline.delete(sessionId);
    }

    function isLive(sessionId: string): boolean {
        return deps.liveSessions().some((session) => session.sessionId === sessionId);
    }

    function stalenessFor(tracked: AutoRestartTracked, agentVersion: string | undefined): Staleness | null {
        return wrapperStaleness({
            wrapperVersion: tracked.wrapperVersion,
            daemonVersion: deps.daemonVersion,
            agentVersion,
            installedAgentVersion: tracked.flavor ? deps.installedAgentVersion(tracked.flavor) : null,
        });
    }

    /** The slot (inFlight / lastStartedAt) is reserved by the caller, synchronously with the decision. */
    async function run(sessionId: string, staleness: Staleness): Promise<void> {
        const since = statuses.get(sessionId)?.since ?? now();
        setStatus(sessionId, { state: 'restarting', since, target: staleness.target });
        publish();
        deps.log?.(`[auto-restart] restarting ${sessionId}: ${staleness.kind} ${staleness.from} → ${staleness.target}`);
        try {
            // Last look right before the stop: a turn / background task / run
            // that started since the check-in wins; no attempt is burned.
            if (deps.turnActive(sessionId) || deps.backgroundTasks(sessionId) > 0 || deps.automationRunning(sessionId)) {
                deps.log?.(`[auto-restart] ${sessionId} became busy before the stop; waiting`);
                setStatus(sessionId, { state: 'waiting', reason: 'turn-active', since, target: staleness.target });
                return;
            }
            let result: { ok: true } | { ok: false; error: string };
            try {
                result = await deps.restart(sessionId, staleness);
            } catch (error) {
                result = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            const record = recordAttempt(attempts.get(sessionId) ?? null, staleness.target, result.ok, now(), result.ok ? undefined : result.error);
            if (record) attempts.set(sessionId, record);
            else attempts.delete(sessionId);
            if (result.ok) {
                deps.log?.(`[auto-restart] ${sessionId} restarted on ${staleness.target}`);
                clearSession(sessionId);
                agentVersions.delete(sessionId);
            } else {
                deps.log?.(`[auto-restart] ${sessionId} restart failed (attempt ${record?.attempts}): ${result.error}`);
                const gaveUp = (record?.attempts ?? 0) >= AUTO_RESTART_MAX_ATTEMPTS;
                if (!isLive(sessionId)) {
                    // The old wrapper is gone and the new one never came up: no
                    // check-in will ever arrive. Say so now, with the reason, and
                    // either retry once ourselves after the backoff or hand it to Restore.
                    offline.set(sessionId, staleness);
                    const retryAt = gaveUp || !record ? undefined : record.notBefore;
                    setStatus(sessionId, { state: 'failed', reason: result.error, since, target: staleness.target, offline: true, ...(retryAt ? { retryAt } : {}) });
                    if (retryAt) schedule(() => { void retryOffline(sessionId); }, Math.max(0, retryAt - now()));
                } else {
                    setStatus(sessionId, gaveUp
                        ? { state: 'failed', reason: result.error, since, target: staleness.target }
                        : { state: 'waiting', reason: 'backoff', since, target: staleness.target });
                }
            }
        } finally {
            inFlight -= 1;
            publish();
        }
    }

    /**
     * The one automatic retry of an offline failure (spec §3). Only while
     * nothing else moved: the switch is on, the session has no wrapper here,
     * and the server has it inactive and unarchived (no Restore, no archive,
     * no resume elsewhere). Anything else drops or defers it; never a third try.
     */
    async function retryOffline(sessionId: string): Promise<void> {
        const staleness = offline.get(sessionId);
        if (!staleness || statuses.get(sessionId)?.state !== 'failed' || statuses.get(sessionId)?.retryAt === undefined) return;
        const status = statuses.get(sessionId)!;
        const handOver = (why: string) => {
            deps.log?.(`[auto-restart] ${sessionId} offline retry skipped: ${why}`);
            setStatus(sessionId, { state: 'failed', reason: status.reason, since: status.since, target: status.target, offline: true });
            publish();
        };
        if (!deps.enabled()) return handOver('switch off');
        if (isLive(sessionId)) { offline.delete(sessionId); return; }
        const server = deps.serverSession ? await deps.serverSession(sessionId).catch(() => null) : null;
        if (!server) return handOver('server state unknown');
        if (server.archived || server.active) return handOver(server.archived ? 'archived' : 'active elsewhere');
        if (isLive(sessionId) || offline.get(sessionId) !== staleness) return;
        const t = now();
        if (inFlight > 0 || (lastStartedAt !== null && t - lastStartedAt < AUTO_RESTART_MIN_GAP_MS)) {
            schedule(() => { void retryOffline(sessionId); }, AUTO_RESTART_MIN_GAP_MS + Math.round(random() * AUTO_RESTART_MIN_GAP_MS));
            return;
        }
        inFlight += 1;
        lastStartedAt = t;
        setStatus(sessionId, { state: 'restarting', since: status.since, target: staleness.target });
        await run(sessionId, staleness);
    }

    /**
     * One wrapper check-in. Returns how soon the wrapper should ask again for
     * this purpose (null = no opinion); a yes starts the restart right after
     * the caller replied.
     */
    async function onCheckIn(request: AutoRestartCheckIn): Promise<{ nextCheckMs: number | null; restarting: boolean }> {
        let t = now();
        const tracked = deps.tracked(request.sessionId, request.pid);
        if (request.report.agentVersion) agentVersions.set(request.sessionId, request.report.agentVersion);
        const staleness = tracked ? stalenessFor(tracked, request.report.agentVersion) : null;
        if (!staleness) {
            const had = statuses.has(request.sessionId);
            clearSession(request.sessionId);
            if (had) publish();
            return { nextCheckMs: null, restarting: false };
        }
        // A wrapper checking in is live again: an offline failure no longer applies.
        offline.delete(request.sessionId);
        const previous = statuses.get(request.sessionId);
        if (previous?.state === 'restarting') return { nextCheckMs: null, restarting: false };
        const attempt = attempts.get(request.sessionId) ?? null;
        let input = {
            enabled: deps.enabled(),
            now: t,
            ...(deps.quietMs !== undefined ? { quietMs: deps.quietMs } : {}),
            staleness,
            trackedLive: !!tracked?.live,
            report: request.report,
            turnActive: deps.turnActive(request.sessionId),
            backgroundTasks: deps.backgroundTasks(request.sessionId),
            automationRunning: deps.automationRunning(request.sessionId),
            resumable: false,
            attempt,
            inFlight,
            lastStartedAt,
        };
        // The server fetch + disk check only once everything else already holds;
        // then every rule again on fresh state (pacing may have moved meanwhile),
        // and the decision and the 'restarting' mark with no await in between.
        let verdict: AutoRestartVerdict = decideAutoRestart({ ...input, resumable: true });
        if (verdict.ok) {
            const resumable = await deps.resumable(request.sessionId).catch(() => false);
            t = now();
            input = {
                ...input,
                now: t,
                trackedLive: !!deps.tracked(request.sessionId, request.pid)?.live,
                turnActive: deps.turnActive(request.sessionId),
                backgroundTasks: deps.backgroundTasks(request.sessionId),
                automationRunning: deps.automationRunning(request.sessionId),
                resumable,
                attempt: attempts.get(request.sessionId) ?? null,
                inFlight,
                lastStartedAt,
            };
            verdict = statuses.get(request.sessionId)?.state === 'restarting' ? { ok: false, reason: 'machine-busy' } : decideAutoRestart(input);
        }
        if (verdict.ok) {
            // Reserve the machine slot and mark it before replying, so neither a
            // second check-in nor another session can start one in parallel.
            inFlight += 1;
            lastStartedAt = t;
            setStatus(request.sessionId, { state: 'restarting', since: previous?.since ?? t, target: staleness.target });
            setImmediate(() => { void run(request.sessionId, staleness); });
            return { nextCheckMs: null, restarting: true };
        }
        if (input.enabled) setStatus(request.sessionId, statusFromVerdict(verdict, previous, staleness, t, attempt));
        else {
            // Off: publish nothing, but keep (or start) the clock for when it comes back on.
            statuses.delete(request.sessionId);
            if (behindSince.get(request.sessionId)?.target !== staleness.target) behindSince.set(request.sessionId, { target: staleness.target, since: t });
        }
        publish();
        return { nextCheckMs: autoRestartNextCheck(verdict, input, random()), restarting: false };
    }

    /**
     * Periodic pass over live sessions: drop sessions that caught up or left,
     * hand never-reporting wrappers to the user (`manual`), and start the
     * clock for reporting ones that have not checked in yet.
     */
    function sweep(): void {
        const t = now();
        const enabled = deps.enabled();
        const seen = new Set<string>();
        for (const session of deps.liveSessions()) {
            seen.add(session.sessionId);
            const staleness = stalenessFor(session, agentVersions.get(session.sessionId));
            if (!staleness) { clearSession(session.sessionId); continue; }
            if (statuses.get(session.sessionId)?.state === 'restarting') continue;
            // Live again (Restore, or a wrapper started by hand): an offline failure no longer applies.
            if (offline.delete(session.sessionId)) statuses.delete(session.sessionId);
            if (!enabled) {
                statuses.delete(session.sessionId);
                if (behindSince.get(session.sessionId)?.target !== staleness.target) behindSince.set(session.sessionId, { target: staleness.target, since: t });
                continue;
            }
            const previous = statuses.get(session.sessionId);
            // The user's own terminal: its wrapper never checks in (no probe), so
            // it can never be proven idle — hand it over now, saying why.
            if (session.startedBy === 'terminal') {
                if (previous?.state !== 'manual' || previous.reason !== 'local-terminal' || previous.target !== staleness.target) {
                    setStatus(session.sessionId, { state: 'manual', reason: 'local-terminal', since: t, target: staleness.target });
                }
                continue;
            }
            if (previous && previous.target === staleness.target) continue;
            const reports = wrapperReportsIdle({
                flavor: session.flavor,
                capabilities: session.capabilities,
                spawnedBy: session.spawnedBy,
                tags: session.tags,
                variant: session.variant,
            });
            setStatus(session.sessionId, reports
                ? { state: 'waiting', reason: 'awaiting-check-in', since: t, target: staleness.target }
                : { state: 'manual', reason: 'no-report', since: t, target: staleness.target });
        }
        for (const id of new Set([...statuses.keys(), ...behindSince.keys()])) {
            if (seen.has(id) || statuses.get(id)?.state === 'restarting') continue;
            // An offline failure stays until the session is back (or the daemon restarts).
            if (offline.has(id)) continue;
            clearSession(id);
        }
        publish();
    }

    return {
        onCheckIn,
        sweep,
        forget(sessionId: string): void {
            agentVersions.delete(sessionId);
            // An exit during our own restart, or of the failed new wrapper, keeps the record.
            const state = statuses.get(sessionId)?.state;
            if (state === 'restarting' || offline.has(sessionId)) return;
            behindSince.delete(sessionId);
            if (statuses.delete(sessionId)) publish();
        },
        statuses(): Record<string, AutoRestartSessionStatus> {
            return Object.fromEntries(statuses);
        },
        /** For tests / diagnostics. */
        inFlight(): number {
            return inFlight;
        },
    };
}
