/**
 * B-507 — "does this session still have background work in flight?" as the
 * daemon and the server can see it. The wrapper-side bookkeeping of WHICH
 * tasks is `claude/backgroundTasks.ts`; this file is the publishing and the
 * daemon-side lease, modelled on B-466's `turnActivity.ts`:
 *
 *  - `BackgroundTaskReporter` (wrapper): decides, on every heartbeat tick,
 *    whether the current set is worth publishing — on a change (edge) and,
 *    while the set is non-empty, every LEASE_MS as a renewal. Each publish
 *    goes to the daemon (`/session-event background_tasks`) and into
 *    agentState (`backgroundTasks: { updatedAt, tasks }`), so both readers
 *    have a timestamp to expire on.
 *  - `BackgroundTaskTracker` (daemon): the last published set per session,
 *    valid until BUSY_TTL_MS without renewal or the wrapper exiting. Feeds
 *    daemon `/list`, the auto-update / handover gate and the Automations
 *    completion judgement.
 *
 * Readers of agentState (`sessions list --all`) apply the same TTL to
 * `updatedAt`, plus the server's `active` flag: a wrapper that died keeps
 * its last agentState forever, and an old daemon never forwards, so a
 * timestamp is the only honest expiry.
 */
import { sameBackgroundTasks, type BackgroundTaskInfo } from '@/claude/backgroundTasks';

/** Renew while the set stays non-empty. */
export const BACKGROUND_TASKS_LEASE_MS = 60_000;
/** A published set without renewal expires after this (> 2 × lease). */
export const BACKGROUND_TASKS_TTL_MS = 150_000;

/** Shape shared by daemon `/list`, `sessions list/read --json` and the Automations runner. */
export interface BackgroundTasksReport {
    count: number;
    tasks: BackgroundTaskInfo[];
    /** ms epoch of the last publish (same machine's clock). */
    reportedAt?: number;
    /** True when a non-empty set was last seen but its lease has expired: count/tasks are zeroed. */
    stale?: boolean;
}

export const EMPTY_BACKGROUND_TASKS: Readonly<BackgroundTasksReport> = Object.freeze({ count: 0, tasks: [] });

/**
 * Pure: fold a stored `{ updatedAt, tasks }` (agentState or daemon tracker)
 * into what a reader may claim now. `active === false` means no wrapper is
 * attached, so nothing can be running whatever the stored set says.
 */
export function backgroundTasksReport(
    stored: { updatedAt?: number; tasks?: readonly BackgroundTaskInfo[] } | null | undefined,
    now: number,
    options: { active?: boolean; ttlMs?: number } = {},
): BackgroundTasksReport {
    const tasks = Array.isArray(stored?.tasks) ? stored!.tasks.filter((task) => task && typeof task.id === 'string') : [];
    const reportedAt = typeof stored?.updatedAt === 'number' ? stored.updatedAt : undefined;
    if (tasks.length === 0) return reportedAt === undefined ? { ...EMPTY_BACKGROUND_TASKS, tasks: [] } : { count: 0, tasks: [], reportedAt };
    const fresh = options.active !== false && reportedAt !== undefined && now - reportedAt <= (options.ttlMs ?? BACKGROUND_TASKS_TTL_MS);
    if (!fresh) return { count: 0, tasks: [], ...(reportedAt !== undefined ? { reportedAt } : {}), stale: true };
    return { count: tasks.length, tasks: tasks.map((task) => ({ ...task })), reportedAt };
}

/** Wrapper side: edge + lease logic; `publish` is the effect. */
export class BackgroundTaskReporter {
    private last: BackgroundTaskInfo[] = [];
    private lastPublishedAt = 0;

    constructor(
        private readonly publish: (tasks: BackgroundTaskInfo[], now: number) => void,
        private readonly leaseMs: number = BACKGROUND_TASKS_LEASE_MS,
    ) {}

    /** Called on every keepAlive tick with the current set; publishes only on an edge or a due renewal. */
    observe(tasks: readonly BackgroundTaskInfo[], now: number = Date.now()): boolean {
        const changed = !sameBackgroundTasks(this.last, tasks);
        const due = tasks.length > 0 && now - this.lastPublishedAt >= this.leaseMs;
        if (!changed && !due) return false;
        this.last = tasks.map((task) => ({ ...task }));
        this.lastPublishedAt = now;
        this.publish(this.last, now);
        return true;
    }

    current(): BackgroundTaskInfo[] {
        return this.last;
    }
}

/** Daemon side: last published set per session, with expiry. */
export class BackgroundTaskTracker {
    private readonly sets = new Map<string, { at: number; tasks: BackgroundTaskInfo[] }>();

    constructor(private readonly ttlMs: number = BACKGROUND_TASKS_TTL_MS) {}

    apply(sessionId: string, tasks: readonly BackgroundTaskInfo[], now: number = Date.now()): void {
        if (tasks.length === 0) this.sets.delete(sessionId);
        else this.sets.set(sessionId, { at: now, tasks: tasks.map((task) => ({ ...task })) });
    }

    /** The wrapper is gone: whatever it reported no longer holds. */
    forget(sessionId: string): void {
        this.sets.delete(sessionId);
    }

    report(sessionId: string, now: number = Date.now()): BackgroundTasksReport {
        const entry = this.sets.get(sessionId);
        if (!entry) return { ...EMPTY_BACKGROUND_TASKS, tasks: [] };
        const out = backgroundTasksReport({ updatedAt: entry.at, tasks: entry.tasks }, now, { ttlMs: this.ttlMs });
        if (out.stale) this.sets.delete(sessionId);
        return out;
    }

    count(sessionId: string, now: number = Date.now()): number {
        return this.report(sessionId, now).count;
    }

    /** Sessions whose published set is still inside the TTL. */
    activeSessions(now: number = Date.now()): string[] {
        return [...this.sets.keys()].filter((id) => this.count(id, now) > 0);
    }

    hasAny(now: number = Date.now()): boolean {
        return this.activeSessions(now).length > 0;
    }
}
