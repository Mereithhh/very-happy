/**
 * B-915 「交接给…」 target list (pure). Any other session of mine that can
 * receive a session message: not this one, not archived, not shared with me
 * (it is someone else's), not a terminal mirror (no wrapper consumes
 * messages). Live sessions first, then most recently active; the search
 * matches title, machine, directory and id prefix.
 */
import type { Machine, Session } from '@/sync/storageTypes';
import { getSessionName } from '@/utils/sessionUtils';
import { machineLabel } from '@/utils/machineUtils';

export interface HandoffCandidate {
    id: string;
    title: string;
    machineId: string | null;
    machineName: string | null;
    /** The session's wrapper is up right now (delivery is immediate; otherwise only a same-project session gets it as a stored message). */
    online: boolean;
    path: string | null;
}

export const HANDOFF_CANDIDATE_LIMIT = 50;

export function handoffCandidates(
    sessions: readonly Session[],
    machines: Readonly<Record<string, Machine | undefined>>,
    selfId: string,
    query: string,
    limit = HANDOFF_CANDIDATE_LIMIT,
): HandoffCandidate[] {
    const q = query.trim().toLowerCase();
    const out: (HandoffCandidate & { at: number })[] = [];
    for (const s of sessions) {
        if (s.id === selfId || s.share || s.archivedAt != null) continue;
        if (s.metadata?.flavor === 'terminal-mirror') continue;
        const machineId = s.metadata?.machineId ?? null;
        const machine = machineId ? machines[machineId] : undefined;
        const candidate = {
            id: s.id,
            title: getSessionName(s),
            machineId,
            machineName: machine ? machineLabel(machine) : (s.metadata?.host ?? null),
            online: s.active,
            path: s.metadata?.path ?? null,
            at: Math.max(s.activeAt ?? 0, s.updatedAt ?? 0),
        };
        if (q && ![candidate.title, candidate.machineName ?? '', candidate.path ?? ''].some((v) => v.toLowerCase().includes(q)) && !s.id.toLowerCase().startsWith(q)) continue;
        out.push(candidate);
    }
    out.sort((a, b) => Number(b.online) - Number(a.online) || b.at - a.at);
    return out.slice(0, limit).map(({ at: _at, ...c }) => c);
}
