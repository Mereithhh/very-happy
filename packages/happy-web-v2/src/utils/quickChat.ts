import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from './machineUtils';
import { withoutTeamWorktrees, isInsideTeamWorktree } from './teamWorktree';

/** One remembered machine+directory combination (settings.recentMachinePaths). */
export interface RecentMachinePath {
    machineId: string;
    path: string;
}

export type QuickChatDecision =
    | { kind: 'spawn'; machineId: string; directory: string }
    | { kind: 'configure' };

/**
 * "Skip the dialog?" decision for the quick new-chat flow. Pure — the
 * orchestrator (app/newChat.ts) feeds it the freshest store state.
 *
 *   always-ask setting on        → configure (the 1% who want the dialog)
 *   explicit/current scope       → exact machine/path, otherwise configure
 *   no machine online            → configure (dialog shows its empty state)
 *   exactly 1 machine online     → that machine
 *   several online               → the machine of the most recent
 *                                  machine+path entry that is online now;
 *                                  none remembered → configure
 *   directory                    → most recent remembered path FOR THAT
 *                                  machine; none → configure (one time —
 *                                  the first successful create records it)
 *   remembered team worktree     → never offered (B-755: a quick chat in
 *                                  one made it the MRU, and the next chats
 *                                  and a new team's folder followed)
 *
 * model/effort/permission are deliberately absent here: they are not spawn
 * inputs at all. Each message resolves them from the per-agent defaults in
 * Settings → Agents (sync/messageMeta.ts); with no explicit override nothing
 * is sent and the machine's own CLI configuration applies.
 */
export function decideQuickChat({
    machines,
    recents,
    alwaysAsk,
    target,
}: {
    machines: Machine[];
    recents: RecentMachinePath[];
    alwaysAsk: boolean;
    target?: RecentMachinePath;
}): QuickChatDecision {
    if (alwaysAsk) return { kind: 'configure' };
    const online = machines.filter(isMachineOnline);
    if (target) {
        // A chosen scope is authoritative; never silently switch hosts/paths.
        if (!target.path.trim() || !online.some(m => m.id === target.machineId)) return { kind: 'configure' };
        return { kind: 'spawn', machineId: target.machineId, directory: target.path };
    }
    if (online.length === 0) return { kind: 'configure' };
    recents = withoutTeamWorktrees(recents);

    let machineId: string;
    if (online.length === 1) {
        machineId = online[0].id;
    } else {
        const onlineIds = new Set(online.map((m) => m.id));
        const recent = recents.find((r) => onlineIds.has(r.machineId));
        if (!recent) return { kind: 'configure' };
        machineId = recent.machineId;
    }

    const directory = recents.find((r) => r.machineId === machineId)?.path;
    if (!directory) return { kind: 'configure' };
    return { kind: 'spawn', machineId, directory };
}

/**
 * Most-recent-first update of the remembered machine+path list: an existing
 * identical entry moves to the front instead of duplicating; the list is
 * capped (schema documents "last 10").
 */
export function pushRecentMachinePath(
    list: RecentMachinePath[],
    entry: RecentMachinePath,
    cap = 10,
): RecentMachinePath[] {
    // B-755: a team worktree is never remembered, and the next write drops ones remembered before.
    const rest = withoutTeamWorktrees(list).filter((r) => !(r.machineId === entry.machineId && r.path === entry.path));
    return (isInsideTeamWorktree(entry.path) ? rest : [entry, ...rest]).slice(0, cap);
}
