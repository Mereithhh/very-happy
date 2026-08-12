/**
 * Assistant session/machine selection (pure, unit-tested).
 *
 * The meta-agent is a singleton claude session per machine, tagged
 * `metadata.variant === 'assistant'`. The web view never trusts itself to be
 * the only writer (daemon-side tag dedupe is the real guarantee) — it just
 * picks the freshest live candidate deterministically.
 */

import type { Session, Machine } from '@/sync/storageTypes';

/**
 * Find the assistant session for a machine: variant-tagged, not archived
 * (`active`), belonging to `machineId`. Ties break by most recent update.
 */
export function pickAssistantSession(sessions: Session[], machineId: string): Session | null {
    let best: Session | null = null;
    for (const s of sessions) {
        if (!s.active) continue;
        if (s.metadata?.variant !== 'assistant') continue;
        if (s.metadata?.machineId !== machineId) continue;
        if (!best || s.updatedAt > best.updatedAt) best = s;
    }
    return best;
}

export type AssistantMachinePick =
    | { kind: 'machine'; machine: Machine }
    | { kind: 'choose'; online: Machine[] }
    | { kind: 'none' };

/**
 * Resolve which machine hosts the assistant:
 * 1. the settings-preferred machine, if it is currently online;
 * 2. otherwise the sole online machine;
 * 3. several online machines with no (online) preference → ask the user;
 * 4. nothing online → none.
 */
export function pickAssistantMachine(
    machines: Machine[],
    preferredId: string | null | undefined,
): AssistantMachinePick {
    const online = machines.filter((m) => m.active);
    if (preferredId) {
        const preferred = online.find((m) => m.id === preferredId);
        if (preferred) return { kind: 'machine', machine: preferred };
    }
    if (online.length === 1) return { kind: 'machine', machine: online[0] };
    if (online.length > 1) return { kind: 'choose', online };
    return { kind: 'none' };
}
