import type { Metadata } from './storageTypes';
import { normalizeAgentKey, type LauncherMachineContext } from './agentDefaults';
import { readAgentVersions } from '@/app/agentVersions';
import { machineCliVersion, type StaleWrapperMachineLike } from '@/app/staleWrapperPolicy';

/**
 * B-844: what a picker without a session can know about models — the live
 * catalogs recent sessions published (the same source pi's settings list
 * uses, sync/piModelOptions.ts) and the target machine's versions.
 */
export type LauncherCatalogSource = {
    updatedAt: number;
    metadata?: Pick<Metadata, 'flavor' | 'machineId' | 'models' | 'defaultModelCode'> | null;
};

/**
 * Newest catalog first, at most one per machine: a machine whose CLI or
 * Codex was upgraded publishes a newer list from its next session, and that
 * list replaces the machine's older ones. `machineId` narrows to one machine
 * (new-session dialog); without it every machine contributes (settings).
 */
export function collectRecentCatalogs(
    sessions: readonly LauncherCatalogSource[],
    flavor: string | null | undefined,
    machineId?: string | null,
): Metadata[] {
    const agent = normalizeAgentKey(flavor);
    const seenMachines = new Set<string>();
    const out: Metadata[] = [];
    for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const metadata = session.metadata;
        if (!metadata?.models?.length || normalizeAgentKey(metadata.flavor) !== agent) continue;
        const machine = metadata.machineId ?? '';
        if (machineId && machine !== machineId) continue;
        if (seenMachines.has(machine)) continue;
        seenMachines.add(machine);
        out.push(metadata as Metadata);
    }
    return out;
}

export function launcherMachineContext(
    machine: (StaleWrapperMachineLike & { daemonState?: unknown }) | null | undefined,
    flavor: string | null | undefined,
    catalog: Metadata | null | undefined,
): LauncherMachineContext | null {
    if (!machine) return null;
    const agent = normalizeAgentKey(flavor);
    const installed = readAgentVersions(machine.daemonState)?.agents.find((entry) => entry.id === agent)?.installed ?? null;
    return {
        cliVersion: machineCliVersion(machine),
        agentVersion: agent === 'claude' ? null : installed,
        catalog: catalog?.models ?? null,
    };
}

export type LauncherModelSource = { context: LauncherMachineContext | null; catalogs: Metadata[] };
