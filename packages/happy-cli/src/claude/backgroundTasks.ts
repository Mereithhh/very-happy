/**
 * B-507 — which background tasks does this Claude session still have in
 * flight? Pure bookkeeping over SDK messages; no I/O.
 *
 * A turn ending is not the session going quiet: an async-launched sub-agent,
 * a `run_in_background` Bash command, a Monitor or a workflow keeps running
 * and will wake the session with a task_notification later. Nothing used to
 * say so explicitly — auto-archive had to guess from event recency and got it
 * wrong (Owner's PR#631 session). This tracker is the explicit answer; the
 * wrapper publishes its `list()` on the heartbeat, to the daemon and into
 * agentState (`update/backgroundTaskActivity.ts`).
 *
 * Signals (SDK 0.3.281, sdk.d.ts):
 *  - `system/background_tasks_changed` is the LEVEL: the full live set after
 *    every membership change, REPLACE semantics — "consumers that only need
 *    'is background work running' should replace their set with each payload
 *    rather than pairing edges". It is per process: nothing at startup, so
 *    `reset()` on every query (re)start.
 *  - the EDGES `task_started{is_backgrounded}` / `task_updated.patch` /
 *    `task_notification` still apply, for Claude Code runtimes that predate
 *    the level signal. Both are applied; for one transition they agree (a
 *    level first makes the edge an idempotent replay, an edge first is
 *    overwritten by the same set), so they cannot fight.
 *  - a foreground Agent whose tool_result carries `tool_use_result.status ===
 *    'async_launched'` moved to the background (B-260-P2's marker) — the
 *    fallback when neither task_started.is_backgrounded nor the level exists.
 *  - `ambient` tasks are "not activity; hosts should exclude them from
 *    activity indicators" — excluded here too.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface BackgroundTaskInfo {
    id: string;
    /** SDK task_type as reported (local_bash / local_agent / monitor / …); 'unknown' when absent. */
    type: string;
    description: string;
    /** Wrapper-local ms epoch of when this task was first seen in the background. */
    startedAt: number;
}

export const BACKGROUND_TASKS_MAX = 50;
export const BACKGROUND_TASK_DESCRIPTION_MAX = 200;

const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : null;
const clip = (value: string): string => value.length <= BACKGROUND_TASK_DESCRIPTION_MAX ? value : `${value.slice(0, BACKGROUND_TASK_DESCRIPTION_MAX - 1)}…`;

const SETTLED_STATUSES = new Set(['completed', 'failed', 'killed']);

/** Same set, same descriptions — the caller uses this to decide whether an edge is worth publishing. */
export function sameBackgroundTasks(a: readonly BackgroundTaskInfo[], b: readonly BackgroundTaskInfo[]): boolean {
    if (a.length !== b.length) return false;
    const byId = new Map(a.map((task) => [task.id, task]));
    for (const task of b) {
        const other = byId.get(task.id);
        if (!other || other.description !== task.description || other.type !== task.type) return false;
    }
    return true;
}

export function createBackgroundTaskTracker() {
    /** Tasks known to be in the background. */
    const background = new Map<string, BackgroundTaskInfo>();
    /** Every task_started we saw (foreground included), so a later move to the background keeps its description. */
    const known = new Map<string, { id: string; type: string; description: string; toolUseId: string | null }>();

    const add = (id: string, now: number, meta?: { type?: string; description?: string }) => {
        const existing = background.get(id);
        const seen = known.get(id);
        background.set(id, {
            id,
            type: meta?.type ?? existing?.type ?? seen?.type ?? 'unknown',
            description: clip(meta?.description ?? existing?.description ?? seen?.description ?? ''),
            startedAt: existing?.startedAt ?? now,
        });
        if (background.size > BACKGROUND_TASKS_MAX) background.delete(background.keys().next().value!);
    };

    function observe(message: SDKMessage, now: number = Date.now()): void {
        const m = message as any;
        if (m.type === 'system') {
            if (m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
                const next = new Set<string>();
                for (const task of m.tasks) {
                    const id = text(task?.task_id);
                    if (!id || task.ambient === true) continue;
                    next.add(id);
                    add(id, now, { type: text(task.task_type) ?? undefined, description: text(task.description) ?? undefined });
                }
                for (const id of [...background.keys()]) if (!next.has(id)) background.delete(id);
                return;
            }
            const id = text(m.task_id);
            if (!id) return;
            if (m.subtype === 'task_started') {
                if (m.ambient === true || m.skip_transcript === true) return;
                const meta = { id, type: text(m.task_type) ?? 'unknown', description: clip(text(m.description) ?? ''), toolUseId: text(m.tool_use_id) };
                known.set(id, meta);
                if (known.size > BACKGROUND_TASKS_MAX * 4) known.delete(known.keys().next().value!);
                if (m.is_backgrounded === true) add(id, now, meta);
                return;
            }
            if (m.subtype === 'task_updated' && m.patch && typeof m.patch === 'object') {
                if (SETTLED_STATUSES.has(String(m.patch.status))) { background.delete(id); return; }
                if (m.patch.is_backgrounded === true) add(id, now, { description: text(m.patch.description) ?? undefined });
                return;
            }
            if (m.subtype === 'task_notification') { background.delete(id); return; }
            return;
        }
        // Foreground Agent moved to the background: its tool_result is the async stub.
        if (m.type === 'user' && m.tool_use_result && typeof m.tool_use_result === 'object' && m.tool_use_result.status === 'async_launched'
            && Array.isArray(m.message?.content)) {
            for (const block of m.message.content) {
                const toolUseId = block?.type === 'tool_result' ? text(block.tool_use_id) : null;
                if (!toolUseId) continue;
                for (const seen of known.values()) if (seen.toolUseId === toolUseId) add(seen.id, now, seen);
            }
        }
    }

    /** A new Claude Code process knows nothing about the old one's tasks (SDK: "reset to the empty set whenever the session's CLI process (re)starts"). */
    function reset(): void {
        background.clear();
        known.clear();
    }

    function list(): BackgroundTaskInfo[] {
        return [...background.values()].sort((a, b) => a.startedAt - b.startedAt).map((task) => ({ ...task }));
    }

    return { observe, reset, list };
}

export type BackgroundTaskTracker = ReturnType<typeof createBackgroundTaskTracker>;
