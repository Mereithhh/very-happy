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
    judgeLanding,
    noEffectReason,
    recordAttempt,
    statusFromVerdict,
    uncheckedWrapperStatus,
    wrapperReportsIdle,
    wrapperStaleness,
    type AttemptRecord,
    type AutoRestartLanding,
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
    /** B-882: legacy check-in grace (tests shorten it via HAPPY_AUTO_RESTART_CHECK_IN_GRACE_MS). */
    checkInGraceMs?: number;
    daemonVersion: string;
    /** Installed agent binary version for this flavor (Codex), from the daemon's agentVersions snapshot. */
    installedAgentVersion: (flavor: string) => string | null;
    /**
     * B-931: ask the binary itself, right before an agent restart (the
     * snapshot is hours old and the install may have been swapped since).
     * null = could not tell (the snapshot stands).
     */
    probeInstalledAgentVersion?: (flavor: string) => Promise<string | null>;
    /** B-931: successful restarts not yet seen to land, persisted across daemon restarts. */
    landings?: {
        read: () => Record<string, AutoRestartLanding>;
        write: (landings: Record<string, AutoRestartLanding>) => void;
    };
    tracked: (sessionId: string, pid: number) => AutoRestartTracked | null;
    /** Every live tracked session (for the sweep). */
    liveSessions: () => Array<{ sessionId: string } & AutoRestartTracked>;
    turnActive: (sessionId: string) => boolean;
    backgroundTasks: (sessionId: string) => number;
    automationRunning: (sessionId: string) => boolean;
    /** `resumePrecheck` against the conversation on disk. */
    /** `resumePrecheck` on the server's (authoritative) metadata against the conversation on disk. */
    resumable: (sessionId: string) => Promise<boolean>;
    /**
     * B-856: the newer CLI this daemon is about to be replaced by (null = none).
     * While set, nothing is restarted onto this daemon's soon-old code.
     */
    upgradePending?: () => string | null;
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
    /**
     * B-911: a stale wrapper the daemon can restart but never prove idle by
     * check-in (`manual` / `no-report` or `no-check-in`) — once per (session,
     * target) entering that state, so the owner hears about it (card + push).
     */
    onStuck?: (sessionId: string, status: AutoRestartSessionStatus, session: AutoRestartTracked) => void;
    /** B-911: a session left that state (caught up, gone, or reclassified). */
    onUnstuck?: (sessionId: string) => void;
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
    /** B-882: when this run started waiting for a wrapper's first check-in. */
    const awaitingSince = new Map<string, number>();
    const schedule = deps.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.(); });
    let inFlight = 0;
    let lastStartedAt: number | null = null;
    let publishedSignature = '';
    const landings = new Map<string, AutoRestartLanding>(Object.entries((() => {
        try { return deps.landings?.read() ?? {}; } catch { return {}; }
    })()));
    function saveLandings(): void {
        try { deps.landings?.write(Object.fromEntries(landings)); }
        catch (error) { deps.log?.(`[auto-restart] could not persist restart records: ${String(error)}`); }
    }

    /**
     * B-931: a restart that already ran for this (session, kind, from, target)
     * changed nothing. True = leave it to the user (status published, logged
     * once); never restart it again until it runs something else.
     */
    function restartHadNoEffect(sessionId: string, staleness: Staleness | null, agentReported: boolean): boolean {
        const landing = landings.get(sessionId);
        const verdict = judgeLanding(landing, staleness);
        if (verdict !== 'no-effect') {
            // An agent record needs the agent's own version to be judged; until
            // the new wrapper reports one, "not stale" proves nothing.
            const undecided = landing?.kind === 'agent' && !agentReported;
            if (landing && !undecided) { landings.delete(sessionId); saveLandings(); }
            return false;
        }
        if (!landing!.noEffect) {
            landings.set(sessionId, { ...landing!, noEffect: true });
            saveLandings();
            deps.log?.(`[auto-restart] ${sessionId}: restart onto ${landing!.target} did not change ${landing!.kind} ${landing!.from}; not restarting it again`);
        }
        const previous = statuses.get(sessionId);
        const reason = noEffectReason(landing!);
        if (previous?.state !== 'failed' || previous.reason !== reason || previous.target !== landing!.target) {
            setStatus(sessionId, { state: 'failed', reason, since: now(), target: landing!.target });
        }
        return true;
    }

    function publish(): void {
        const snapshot = Object.fromEntries([...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)));
        const signature = JSON.stringify(snapshot);
        if (signature === publishedSignature) return;
        publishedSignature = signature;
        deps.publish(snapshot);
    }

    /** B-911: restartable wrappers that can never check in (the owner decides when). */
    const isStuck = (status: AutoRestartSessionStatus | undefined): boolean =>
        status?.state === 'manual' && (status.reason === 'no-report' || status.reason === 'no-check-in');
    function noteStuck(sessionId: string, before: AutoRestartSessionStatus | undefined, session?: AutoRestartTracked): void {
        const after = statuses.get(sessionId);
        if (isStuck(after) && session && !(isStuck(before) && before!.target === after!.target)) deps.onStuck?.(sessionId, after!, session);
        else if (isStuck(before) && !isStuck(after)) deps.onUnstuck?.(sessionId);
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
        const before = statuses.get(sessionId);
        statuses.delete(sessionId);
        if (isStuck(before)) deps.onUnstuck?.(sessionId);
        behindSince.delete(sessionId);
        offline.delete(sessionId);
        awaitingSince.delete(sessionId);
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
            // B-856: an upgrade got queued since the decision; the new daemon restarts it once.
            const pending = deps.upgradePending?.() ?? null;
            if (pending) {
                deps.log?.(`[auto-restart] ${sessionId} left to the next daemon: upgrade to ${pending} pending`);
                setStatus(sessionId, { state: 'waiting', reason: 'upgrade-pending', since, target: staleness.target });
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
                deps.log?.(`[auto-restart] ${sessionId} restarted (${staleness.kind} ${staleness.from} → ${staleness.target}); confirmed on its next check-in`);
                clearSession(sessionId);
                agentVersions.delete(sessionId);
                landings.set(sessionId, { kind: staleness.kind, from: staleness.from, target: staleness.target, at: now() });
                saveLandings();
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
        let staleness = tracked ? stalenessFor(tracked, request.report.agentVersion) : null;
        const beforeGuard = statuses.get(request.sessionId);
        if (tracked && restartHadNoEffect(request.sessionId, staleness, !!request.report.agentVersion)) {
            noteStuck(request.sessionId, beforeGuard);
            publish();
            return { nextCheckMs: null, restarting: false };
        }
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
            upgradePending: deps.upgradePending?.() ?? null,
            inFlight,
            lastStartedAt,
        };
        // The server fetch + disk check only once everything else already holds;
        // then every rule again on fresh state (pacing may have moved meanwhile),
        // and the decision and the 'restarting' mark with no await in between.
        let verdict: AutoRestartVerdict = decideAutoRestart({ ...input, resumable: true });
        if (verdict.ok && staleness.kind === 'agent' && tracked?.flavor && deps.probeInstalledAgentVersion) {
            // B-931: the snapshot may predate a reinstall / downgrade; the binary decides.
            const fresh = await deps.probeInstalledAgentVersion(tracked.flavor).catch(() => null);
            if (fresh) {
                const rechecked = wrapperStaleness({ wrapperVersion: tracked.wrapperVersion, daemonVersion: deps.daemonVersion, agentVersion: request.report.agentVersion, installedAgentVersion: fresh });
                if (fresh !== staleness.target) deps.log?.(`[auto-restart] ${request.sessionId}: installed ${tracked.flavor} is ${fresh}, not ${staleness.target}`);
                if (!rechecked) {
                    const had = statuses.has(request.sessionId);
                    clearSession(request.sessionId);
                    if (had) publish();
                    return { nextCheckMs: null, restarting: false };
                }
                staleness = rechecked;
                input = { ...input, staleness };
                verdict = decideAutoRestart({ ...input, resumable: true });
            }
        }
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
                upgradePending: deps.upgradePending?.() ?? null,
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
            const chosen = staleness;
            setStatus(request.sessionId, { state: 'restarting', since: previous?.since ?? t, target: chosen.target });
            noteStuck(request.sessionId, previous);
            setImmediate(() => { void run(request.sessionId, chosen); });
            return { nextCheckMs: null, restarting: true };
        }
        if (input.enabled) setStatus(request.sessionId, statusFromVerdict(verdict, previous, staleness, t, attempt));
        else {
            // Off: publish nothing, but keep (or start) the clock for when it comes back on.
            statuses.delete(request.sessionId);
            if (behindSince.get(request.sessionId)?.target !== staleness.target) behindSince.set(request.sessionId, { target: staleness.target, since: t });
        }
        // A `no-check-in` wrapper that checked in after all is not stuck any more.
        noteStuck(request.sessionId, previous);
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
            if (statuses.get(session.sessionId)?.state === 'restarting') continue;
            // B-931: only a reported agent version can show an agent restart had no effect.
            if (staleness && restartHadNoEffect(session.sessionId, staleness, agentVersions.has(session.sessionId))) continue;
            if (!staleness) { clearSession(session.sessionId); continue; }
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
            // B-882: a wrapper still awaiting its first check-in is looked at
            // again every sweep — its origin may have been learned since, or
            // its silence outlasted the legacy grace.
            const awaiting = previous?.target === staleness.target && previous.state === 'waiting' && previous.reason === 'awaiting-check-in';
            if (previous && previous.target === staleness.target && !awaiting) continue;
            if (!awaiting) awaitingSince.set(session.sessionId, t);
            const next = uncheckedWrapperStatus({
                reportsIdle: wrapperReportsIdle({
                    flavor: session.flavor,
                    capabilities: session.capabilities,
                    spawnedBy: session.spawnedBy,
                    tags: session.tags,
                    variant: session.variant,
                }),
                capabilities: session.capabilities,
                awaitingSince: awaitingSince.get(session.sessionId) ?? null,
                now: t,
                ...(deps.checkInGraceMs !== undefined ? { graceMs: deps.checkInGraceMs } : {}),
            });
            if (awaiting && next.state === 'waiting') continue;
            if (next.state === 'manual') {
                awaitingSince.delete(session.sessionId);
                if (next.reason === 'no-check-in') deps.log?.(`[auto-restart] ${session.sessionId}: wrapper ${session.wrapperVersion ?? '?'} never checked in; left to the user`);
            }
            setStatus(session.sessionId, { ...next, since: t, target: staleness.target });
            noteStuck(session.sessionId, previous, session);
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
            awaitingSince.delete(sessionId);
            const before = statuses.get(sessionId);
            if (statuses.delete(sessionId)) publish();
            if (isStuck(before)) deps.onUnstuck?.(sessionId);
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
