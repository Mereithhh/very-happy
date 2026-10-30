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
        if (status) statuses.set(sessionId, status);
        else statuses.delete(sessionId);
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
                setStatus(sessionId, null);
                agentVersions.delete(sessionId);
            } else {
                deps.log?.(`[auto-restart] ${sessionId} restart failed (attempt ${record?.attempts}): ${result.error}`);
                const gaveUp = (record?.attempts ?? 0) >= AUTO_RESTART_MAX_ATTEMPTS;
                setStatus(sessionId, gaveUp
                    ? { state: 'failed', reason: result.error, since, target: staleness.target }
                    : { state: 'waiting', reason: 'backoff', since, target: staleness.target });
            }
        } finally {
            inFlight -= 1;
            publish();
        }
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
            if (statuses.delete(request.sessionId)) publish();
            return { nextCheckMs: null, restarting: false };
        }
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
        else statuses.delete(request.sessionId);
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
            if (!enabled || !staleness) { statuses.delete(session.sessionId); continue; }
            const previous = statuses.get(session.sessionId);
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
        for (const id of [...statuses.keys()]) {
            if (!seen.has(id) && statuses.get(id)?.state !== 'restarting') statuses.delete(id);
        }
        publish();
    }

    return {
        onCheckIn,
        sweep,
        forget(sessionId: string): void {
            agentVersions.delete(sessionId);
            if (statuses.get(sessionId)?.state !== 'restarting' && statuses.delete(sessionId)) publish();
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
