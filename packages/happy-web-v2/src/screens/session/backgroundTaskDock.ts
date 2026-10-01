/**
 * B-518 — the "what is still running in this session" dock, pure part.
 *
 * Owner report (2026-10-02, 「kimi问题修复与oncall配置」): the sidebar said
 * 「后台任务 2 个」 for 34 hours while the session page showed nothing running.
 * Both were half right: two `run_in_background` Bash wait-loops really were
 * alive on dev-sg (their `pgrep -f` matched their own command line, so they
 * never exited), and the page had no surface for work that outlives a turn —
 * the dock only listed the CURRENT turn's sub-agent cards, and only while the
 * main agent was live.
 *
 * Source of truth, in this order (Claude Desktop / Claude Code keep the same
 * split: a live list beside the composer, the transcript keeps the spawn card
 * where it happened and never reorders):
 *  - the heartbeat COUNT (`heartbeatLease.backgroundTaskCount`) decides
 *    whether anything is running at all — it expires with the lease;
 *  - `agentState.backgroundTasks.tasks` (B-507) supplies WHICH tasks;
 *  - the current turn's running sub-agent cards stay as before (they exist
 *    before the SDK reports them as backgrounded); a background task that IS
 *    one of those cards is shown once, as the card.
 */
import type { ToolCallMessage } from '@/sync/typesMessage';

export type ReportedBackgroundTask = {
    id: string;
    type?: string | null;
    description?: string | null;
    startedAt?: number | null;
};

export type BackgroundTaskEntry = {
    id: string;
    kind: 'command' | 'monitor' | 'agent' | 'other';
    description: string | null;
    startedAt: number | null;
};

export function backgroundTaskKind(type: string | null | undefined): BackgroundTaskEntry['kind'] {
    if (type === 'local_bash') return 'command';
    if (type === 'monitor') return 'monitor';
    if (type === 'local_agent' || type === 'remote_agent') return 'agent';
    return 'other';
}

const cardDescription = (card: ToolCallMessage): string | null => {
    const value = (card.tool.input as Record<string, unknown> | null | undefined)?.description;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * Tasks to list beside the sub-agent cards. `liveCount` is the heartbeat's
 * claim; 0 (expired lease, old CLI, wrapper gone) lists nothing whatever the
 * stored agentState says — a dead wrapper keeps its last agentState forever.
 */
export function backgroundTaskEntries(
    reported: readonly ReportedBackgroundTask[] | null | undefined,
    liveCount: number,
    cards: readonly ToolCallMessage[],
): BackgroundTaskEntry[] {
    if (liveCount <= 0 || !reported?.length) return [];
    const cardDescriptions = new Set(cards.map(cardDescription).filter((d): d is string => d !== null));
    const out: BackgroundTaskEntry[] = [];
    for (const task of reported) {
        if (!task?.id) continue;
        const kind = backgroundTaskKind(task.type);
        const description = typeof task.description === 'string' && task.description.trim() ? task.description.trim() : null;
        if (kind === 'agent' && description && cardDescriptions.has(description)) continue;
        out.push({ id: task.id, kind, description, startedAt: typeof task.startedAt === 'number' ? task.startedAt : null });
    }
    return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** Compact age for a chip: 45s / 12m / 3h / 2d. */
export function formatTaskAge(startedAt: number | null, now: number): string | null {
    if (startedAt === null || !(now >= startedAt)) return null;
    const s = Math.floor((now - startedAt) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}
