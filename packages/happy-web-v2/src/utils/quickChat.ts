import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from './machineUtils';

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
 *   no machine online            → configure (dialog shows its empty state)
 *   exactly 1 machine online     → that machine
 *   several online               → the machine of the most recent
 *                                  machine+path entry that is online now;
 *                                  none remembered → configure
 *   directory                    → most recent remembered path FOR THAT
 *                                  machine; none → configure (one time —
 *                                  the first successful create records it)
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
}: {
    machines: Machine[];
    recents: RecentMachinePath[];
    alwaysAsk: boolean;
}): QuickChatDecision {
    if (alwaysAsk) return { kind: 'configure' };
    const online = machines.filter(isMachineOnline);
    if (online.length === 0) return { kind: 'configure' };

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
    const rest = list.filter((r) => !(r.machineId === entry.machineId && r.path === entry.path));
    return [entry, ...rest].slice(0, cap);
}
