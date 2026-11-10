/**
 * B-911 — the daemon's queue of "restart this session once it is idle"
 * requests (rules: `update/idleRestartPolicy.ts`). The owner's
 * 「本轮结束后重启」 (RPC `restart-session` + `whenIdle`) and the agent's own
 * `request_idle_restart` land here; each waits until the session is idle, then
 * the daemon's ordinary in-place restart runs (history via `--resume`, the
 * same session row, the published permission mode, and the run intent —
 * `run.ts` adds what an old wrapper never recorded).
 *
 * One restart runs at a time machine-wide. The queue and the agent's rate-limit
 * history are persisted, so a daemon handover (upgrade) keeps them.
 */
import {
    agentRestartRefusal,
    AGENT_RESTART_PENDING_TTL_MS,
    AGENT_RESTART_WINDOW_MS,
    idleRestartReady,
    wrapperReportsTurns,
    type IdleRestartSource,
    type IdleRestartWait,
} from '@/update/idleRestartPolicy';
import type { TurnEvent } from '@/update/turnActivity';

export interface IdleRestartSessionFacts {
    live: boolean;
    wrapperVersion?: string | null;
    flavor?: string | null;
    variant?: string | null;
    startedBy?: string | null;
}

export interface IdleRestartEntry {
    source: IdleRestartSource;
    requestedAt: number;
    /** Owner requests from the stale-wrapper card: the version it will come back on. */
    target?: string | null;
}

export interface IdleRestartPersisted {
    version: 1;
    pending: Record<string, IdleRestartEntry>;
    agentAccepted: Record<string, number[]>;
    lastRestartAt: Record<string, number>;
}

export type IdleRestartRefusalCode =
    | 'not-live' | 'local-terminal' | 'assistant' | 'unsupported-flavor' | 'no-turn-reports' | 'not-resumable'
    | 'rate-limited' | 'cooldown' | 'not-caller';

export type IdleRestartRequestResult =
    | { ok: true; state: 'queued' | 'already-queued'; requestedAt: number }
    | { ok: false; code: IdleRestartRefusalCode; retryAfterMs?: number };

export interface IdleRestartDeps {
    now?: () => number;
    quietMs: number;
    observeMs: number;
    checkMs: number;
    session: (sessionId: string) => IdleRestartSessionFacts | null;
    turnActive: (sessionId: string) => boolean;
    backgroundTasks: (sessionId: string) => number;
    automationRunning: (sessionId: string) => boolean;
    upgradePending: () => string | null;
    resumable: (sessionId: string) => Promise<boolean>;
    restart: (sessionId: string, entry: IdleRestartEntry) => Promise<{ ok: true } | { ok: false; error: string }>;
    load?: () => IdleRestartPersisted | null;
    save?: (state: IdleRestartPersisted) => void;
    /** Timer for the periodic look (tests drive `check` by hand). */
    setTimer?: (fn: () => void, ms: number) => { clear: () => void };
    onQueued?: (sessionId: string, entry: IdleRestartEntry) => void;
    onSettled?: (sessionId: string, entry: IdleRestartEntry, outcome: { ok: true } | { ok: false; error: string }) => void;
    log?: (message: string) => void;
}

const RESTARTABLE_FLAVORS = new Set(['claude', 'codex', 'acp']);

export function createIdleRestart(deps: IdleRestartDeps) {
    const now = () => (deps.now ?? Date.now)();
    const loaded = deps.load?.() ?? null;
    const pending = new Map<string, IdleRestartEntry>(Object.entries(loaded?.pending ?? {}));
    const agentAccepted = new Map<string, number[]>(Object.entries(loaded?.agentAccepted ?? {}));
    const lastRestartAt = new Map<string, number>(Object.entries(loaded?.lastRestartAt ?? {}));
    const lastTurnEventAt = new Map<string, number>();
    const lastTurnEndedAt = new Map<string, number>();
    /**
     * When THIS daemon started watching each request: the request time, or —
     * for one inherited from the previous daemon — its load time. A new daemon
     * knows nothing of turns and background tasks until their next lease
     * renewal (≤60 s), so the observation window must restart with it
     * (11-11 e2e: a persisted request was restarted 12 s after a handover,
     * mid background task).
     */
    const watchingSince = new Map<string, number>([...pending.keys()].map(id => [id, now()]));
    const waits = new Map<string, IdleRestartWait>();
    let running: string | null = null;
    let timer: { clear: () => void } | null = null;
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return { clear: () => clearTimeout(handle) };
    });

    function persist(): void {
        const t = now();
        for (const [id, list] of agentAccepted) {
            const kept = list.filter(at => t - at < AGENT_RESTART_WINDOW_MS);
            if (kept.length) agentAccepted.set(id, kept); else agentAccepted.delete(id);
        }
        for (const [id, at] of lastRestartAt) if (t - at >= AGENT_RESTART_WINDOW_MS) lastRestartAt.delete(id);
        try {
            deps.save?.({ version: 1, pending: Object.fromEntries(pending), agentAccepted: Object.fromEntries(agentAccepted), lastRestartAt: Object.fromEntries(lastRestartAt) });
        } catch (error) {
            deps.log?.(`[idle-restart] could not persist the queue: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function schedule(ms: number): void {
        if (pending.size === 0) return;
        timer?.clear();
        timer = setTimer(() => { timer = null; void check(); }, ms);
    }

    function drop(sessionId: string, why: string): void {
        const entry = pending.get(sessionId);
        if (!entry) return;
        pending.delete(sessionId);
        waits.delete(sessionId);
        watchingSince.delete(sessionId);
        persist();
        deps.log?.(`[idle-restart] ${sessionId}: dropped (${why})`);
        deps.onSettled?.(sessionId, entry, { ok: false, error: why });
    }

    async function request(input: { sessionId: string; source: IdleRestartSource; target?: string | null }): Promise<IdleRestartRequestResult> {
        const { sessionId, source } = input;
        const facts = deps.session(sessionId);
        if (!facts?.live) return { ok: false, code: 'not-live' };
        if (facts.startedBy === 'terminal') return { ok: false, code: 'local-terminal' };
        if (facts.variant) return { ok: false, code: 'assistant' };
        if (!RESTARTABLE_FLAVORS.has(facts.flavor ?? 'claude')) return { ok: false, code: 'unsupported-flavor' };
        if (!wrapperReportsTurns(facts.wrapperVersion)) return { ok: false, code: 'no-turn-reports' };
        const existing = pending.get(sessionId);
        if (existing) {
            // The owner's button on top of the agent's own request makes it the owner's (no TTL).
            if (source === 'owner' && existing.source === 'agent') { existing.source = 'owner'; existing.target = input.target ?? existing.target ?? null; persist(); }
            return { ok: true, state: 'already-queued', requestedAt: existing.requestedAt };
        }
        const t = now();
        if (source === 'agent') {
            const refusal = agentRestartRefusal({ now: t, accepted: agentAccepted.get(sessionId) ?? [], lastRestartAt: lastRestartAt.get(sessionId) ?? null });
            if (refusal) return { ok: false, code: refusal.code, retryAfterMs: refusal.retryAfterMs };
        }
        if (!(await deps.resumable(sessionId).catch(() => false))) return { ok: false, code: 'not-resumable' };
        if (pending.has(sessionId)) return { ok: true, state: 'already-queued', requestedAt: pending.get(sessionId)!.requestedAt };
        const entry: IdleRestartEntry = { source, requestedAt: t, ...(input.target ? { target: input.target } : {}) };
        pending.set(sessionId, entry);
        watchingSince.set(sessionId, t);
        if (source === 'agent') agentAccepted.set(sessionId, [...(agentAccepted.get(sessionId) ?? []), t]);
        persist();
        deps.log?.(`[idle-restart] ${sessionId}: queued by the ${source}`);
        deps.onQueued?.(sessionId, entry);
        schedule(deps.checkMs);
        return { ok: true, state: 'queued', requestedAt: t };
    }

    /** One pass over the queue; at most one restart starts (and runs to completion) per pass. */
    async function check(): Promise<void> {
        if (running) return;
        const t = now();
        for (const [sessionId, entry] of [...pending.entries()].sort((a, b) => a[1].requestedAt - b[1].requestedAt)) {
            const facts = deps.session(sessionId);
            if (!facts?.live) { drop(sessionId, 'session has no live wrapper'); continue; }
            if (entry.source === 'agent' && t - entry.requestedAt >= AGENT_RESTART_PENDING_TTL_MS) { drop(sessionId, 'never idle within the request lifetime'); continue; }
            const verdict = idleRestartReady({
                now: t,
                requestedAt: Math.max(entry.requestedAt, watchingSince.get(sessionId) ?? entry.requestedAt),
                turnActive: deps.turnActive(sessionId),
                backgroundTasks: deps.backgroundTasks(sessionId),
                automationRunning: deps.automationRunning(sessionId),
                upgradePending: deps.upgradePending(),
                lastTurnEventAt: lastTurnEventAt.get(sessionId) ?? null,
                lastTurnEndedAt: lastTurnEndedAt.get(sessionId) ?? null,
                quietMs: deps.quietMs,
                observeMs: deps.observeMs,
            });
            if (!verdict.ready) { waits.set(sessionId, verdict.wait); continue; }
            running = sessionId;
            waits.delete(sessionId);
            deps.log?.(`[idle-restart] ${sessionId}: idle, restarting (${entry.source})`);
            let outcome: { ok: true } | { ok: false; error: string };
            try {
                outcome = await deps.restart(sessionId, entry);
            } catch (error) {
                outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
            } finally {
                running = null;
            }
            pending.delete(sessionId);
            watchingSince.delete(sessionId);
            if (outcome.ok) lastRestartAt.set(sessionId, now());
            persist();
            deps.log?.(`[idle-restart] ${sessionId}: ${outcome.ok ? 'restarted' : `restart failed: ${outcome.error}`}`);
            deps.onSettled?.(sessionId, entry, outcome);
            break;
        }
        schedule(deps.checkMs);
    }

    return {
        request,
        check,
        /** Every applied turn edge (`TurnActivityTracker.onEvent`). */
        noteTurn(sessionId: string, event: TurnEvent): void {
            const t = now();
            lastTurnEventAt.set(sessionId, t);
            if (event === 'turn_ended') {
                lastTurnEndedAt.set(sessionId, t);
                if (pending.has(sessionId)) schedule(deps.quietMs + 500);
            }
        },
        /** The wrapper exited. Our own restart's stop is not a reason to drop anything. */
        forget(sessionId: string): void {
            if (running === sessionId) return;
            lastTurnEventAt.delete(sessionId);
            lastTurnEndedAt.delete(sessionId);
            if (pending.has(sessionId)) drop(sessionId, 'wrapper exited');
        },
        /** Kick the timer after load (persisted entries from the previous daemon). */
        start(): void { schedule(deps.checkMs); },
        stop(): void { timer?.clear(); timer = null; },
        status(sessionId: string): (IdleRestartEntry & { wait?: IdleRestartWait; restarting?: true }) | undefined {
            const entry = pending.get(sessionId);
            if (!entry) return undefined;
            return { ...entry, ...(waits.get(sessionId) ? { wait: waits.get(sessionId) } : {}), ...(running === sessionId ? { restarting: true as const } : {}) };
        },
        pendingIds(): string[] { return [...pending.keys()]; },
    };
}
export type IdleRestart = ReturnType<typeof createIdleRestart>;
