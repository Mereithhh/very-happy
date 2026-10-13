/**
 * B-587 — daemon side of idle hibernation: answers `/session-hibernate-check`
 * from machine policy + its own trackers, and remembers which sessions it
 * let go so the exit is recorded as a hibernation (not a crash, not an
 * archive). Effects are injected; the rules are `hibernationPolicy.ts`.
 */
import {
    decideDaemonHibernation,
    nextCheckDelay,
    reportSignature,
    type WrapperIdleSnapshot,
} from './hibernationPolicy';

export const AUTOMATION_BINDINGS_TTL_MS = 10 * 60 * 1000;
/** An approved hibernation that never exited stops blocking others after this. */
export const HIBERNATION_IN_FLIGHT_MS = 60_000;

export interface DaemonHibernationDeps {
    /** Effective idle threshold (0 = off). Read on every check so a setting change applies at once. */
    idleMs: () => number;
    checkMs: number;
    /** Live tracked wrapper for this session with this pid? Plus its spawn origin. */
    tracked: (sessionId: string, pid: number) => { live: boolean; spawnedBy?: string } | null;
    teamsMember: (sessionId: string) => boolean;
    turnActive: (sessionId: string) => boolean;
    backgroundTasks: (sessionId: string) => number;
    /** Session ids Automations reuse. Throw = unknown (fail closed); [] = none. */
    loadAutomationBindings: () => Promise<string[]>;
    now?: () => number;
    log?: (message: string) => void;
}

export interface HibernateCheckRequest {
    sessionId: string;
    pid: number;
    report: WrapperIdleSnapshot;
}

export interface HibernateCheckReply {
    hibernate: boolean;
    reason?: string;
    idleMs?: number;
    nextCheckMs?: number;
}

export function createDaemonHibernation(deps: DaemonHibernationDeps) {
    const now = () => (deps.now ?? Date.now)();
    const signatures = new Map<string, string>();
    /** sessionId → approval time. */
    const approved = new Map<string, number>();
    let bindings: { at: number; ids: Set<string> } | null = null;
    let bindingsInFlight: Promise<Set<string> | null> | null = null;

    async function automationBound(): Promise<Set<string> | null> {
        if (bindings && now() - bindings.at < AUTOMATION_BINDINGS_TTL_MS) return bindings.ids;
        if (!bindingsInFlight) {
            bindingsInFlight = deps.loadAutomationBindings()
                .then((ids) => {
                    bindings = { at: now(), ids: new Set(ids) };
                    return bindings.ids;
                })
                .catch((error) => {
                    deps.log?.(`[hibernate] automation bindings unknown: ${error instanceof Error ? error.message : String(error)}`);
                    return null;
                })
                .finally(() => { bindingsInFlight = null; });
        }
        return bindingsInFlight;
    }

    function inFlight(except: string): boolean {
        const t = now();
        for (const [id, at] of approved) {
            if (t - at > HIBERNATION_IN_FLIGHT_MS) approved.delete(id);
            else if (id !== except) return true;
        }
        return false;
    }

    async function check(request: HibernateCheckRequest): Promise<HibernateCheckReply> {
        const idleMs = deps.idleMs();
        const t = now();
        const tracked = deps.tracked(request.sessionId, request.pid);
        const signature = reportSignature(request.report);
        const previousSignature = signatures.get(request.sessionId);
        signatures.set(request.sessionId, signature);
        // Cheap rules first; only fetch Automations when everything else holds.
        const base = {
            idleMs,
            now: t,
            sessionId: request.sessionId,
            pid: request.pid,
            report: request.report,
            trackedLive: !!tracked?.live,
            trackedSpawnedBy: tracked?.spawnedBy,
            teamsMember: deps.teamsMember(request.sessionId),
            turnActive: deps.turnActive(request.sessionId),
            backgroundTasks: deps.backgroundTasks(request.sessionId),
            previousSignature,
            hibernationInFlight: inFlight(request.sessionId),
        };
        let verdict = decideDaemonHibernation({ ...base, automationBound: new Set() });
        if (verdict.ok || verdict.reason === 'unconfirmed' || verdict.reason === 'busy') {
            verdict = decideDaemonHibernation({ ...base, automationBound: await automationBound() });
        }
        if (verdict.ok) {
            approved.set(request.sessionId, t);
            signatures.delete(request.sessionId);
            deps.log?.(`[hibernate] approved ${request.sessionId} (pid ${request.pid}, idle ${Math.round((t - request.report.lastActivityAt) / 1000)}s)`);
            return { hibernate: true, idleMs };
        }
        const next = verdict.reason === 'unconfirmed'
            ? deps.checkMs
            : nextCheckDelay(verdict, request.report, idleMs, deps.checkMs, t);
        return { hibernate: false, reason: verdict.reason, idleMs, nextCheckMs: next };
    }

    return {
        check,
        /** Called when the wrapper exits: true when this exit is the hibernation we approved. */
        consumeExit(sessionId: string): boolean {
            const at = approved.get(sessionId);
            approved.delete(sessionId);
            signatures.delete(sessionId);
            return at !== undefined && now() - at <= HIBERNATION_IN_FLIGHT_MS * 5;
        },
        forget(sessionId: string): void {
            signatures.delete(sessionId);
        },
        /** Drop the cached Automations bindings (e.g. after the setting changed). */
        invalidateBindings(): void {
            bindings = null;
        },
    };
}

/**
 * Session ids Automations reuse on this machine: every `send` target plus
 * every sticky binding of a sticky `spawn`. Paused automations count too
 * (they can be resumed at any time).
 */
export async function collectAutomationBindings(client: {
    list: (machineId?: string) => Promise<Array<{ id: string; action: unknown }>>;
    stickies: (id: string) => Promise<Array<{ sessionId: string }>>;
}, machineId: string): Promise<string[]> {
    const ids = new Set<string>();
    const automations = await client.list(machineId);
    for (const automation of automations) {
        const action = automation.action as { kind?: unknown; sessionId?: unknown; sticky?: unknown } | null;
        if (action?.kind === 'send' && typeof action.sessionId === 'string') ids.add(action.sessionId);
        if (action?.kind === 'spawn' && action.sticky) {
            for (const sticky of await client.stickies(automation.id)) ids.add(sticky.sessionId);
        }
    }
    return [...ids];
}
