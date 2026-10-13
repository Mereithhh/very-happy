/**
 * B-587 review P3-4 — scheduled work INSIDE the Claude Code process.
 * `CronCreate` (session cron) and `ScheduleWakeup` (/loop self-pacing) live
 * in the running Claude process; hibernating it would silently drop them.
 * Conservative: every CronCreate counts until a CronDelete (or a failed
 * create), a ScheduleWakeup counts until its delay has passed (+ grace).
 */
export const SCHEDULE_WAKEUP_GRACE_MS = 60_000;

type Block = { type?: unknown; name?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };

export function createScheduledWakeupTracker() {
    const crons = new Set<string>();
    const wakeups = new Map<string, number>();
    let cronDeletes = 0;

    function observe(message: unknown, now: number = Date.now()): void {
        const m = message as { type?: unknown; message?: { content?: unknown } } | null;
        const content = Array.isArray(m?.message?.content) ? (m!.message!.content as Block[]) : [];
        if (m?.type === 'assistant') {
            for (const block of content) {
                if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
                if (block.name === 'CronCreate') crons.add(block.id);
                if (block.name === 'CronDelete') cronDeletes += 1;
                if (block.name === 'ScheduleWakeup') {
                    const delay = Number((block.input as { delaySeconds?: unknown } | null)?.delaySeconds);
                    wakeups.set(block.id, now + (Number.isFinite(delay) && delay > 0 ? delay * 1000 : 0) + SCHEDULE_WAKEUP_GRACE_MS);
                }
            }
        }
        if (m?.type === 'user') {
            for (const block of content) {
                if (block?.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
                    crons.delete(block.tool_use_id);
                    wakeups.delete(block.tool_use_id);
                }
            }
        }
    }

    /** How many scheduled items may still fire in this process. */
    function pending(now: number = Date.now()): number {
        for (const [id, until] of wakeups) if (until <= now) wakeups.delete(id);
        return Math.max(0, crons.size - cronDeletes) + wakeups.size;
    }

    return { observe, pending };
}

export type ScheduledWakeupTracker = ReturnType<typeof createScheduledWakeupTracker>;
