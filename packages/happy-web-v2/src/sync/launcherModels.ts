import type { Metadata } from './storageTypes';
import { normalizeAgentKey, type LauncherMachineContext } from './agentDefaults';
import { readLongContextUnsupported } from '@slopus/happy-wire';
import { readAgentVersions } from '@/app/agentVersions';
import { catalogRunnableKeys } from '@/components/modelModeOptions';
import { machineCliVersion, type StaleWrapperMachineLike } from '@/app/staleWrapperPolicy';
import { isPartialPiCatalog, piCatalogFromMachine, readPiModelTable } from './piModelTable';

/**
 * B-844: what a picker without a session can know about models — the live
 * catalogs recent sessions published (the same source pi's settings list
 * uses, sync/piModelOptions.ts) and the target machine's versions.
 */
export type LauncherCatalogSource = {
    updatedAt: number;
    /** Ordering key: the newest STARTED session reflects the machine's current
     *  CLI/Codex and config; updatedAt moves on any status change (a daemon
     *  restart touches every old session). */
    createdAt?: number;
    metadata?: Pick<Metadata, 'flavor' | 'machineId' | 'models' | 'defaultModelCode' | 'configuredModel' | 'longContextUnsupported'> | null;
};

/**
 * B-851: a fork's wrapper publishes its own `metadata.models` only once it
 * starts the agent, so until the first send the picker would fall back to the
 * code list and show its older alias labels ("sonnet 5" for a session running
 * Sonnet 5.5). The parent ran the same agent on the same machine moments ago:
 * borrow its catalog until the fork publishes one.
 */
export function forkCatalogSource<M extends Pick<Metadata, 'flavor' | 'machineId' | 'models'>>(
    metadata: M | null,
    parent: M | null | undefined,
): M | null {
    if (!metadata || metadata.models?.length || !parent?.models?.length) return metadata;
    if (normalizeAgentKey(parent.flavor) !== normalizeAgentKey(metadata.flavor) || parent.machineId !== metadata.machineId) return metadata;
    return parent;
}

/**
 * Newest-started catalog first, at most one per machine: a machine whose CLI or
 * Codex was upgraded publishes a newer list from its next session, and that
 * list replaces the machine's older ones. `machineId` narrows to one machine
 * (new-session dialog); without it every machine contributes (settings).
 *
 * B-978: pi has no list of its own before a session, so the machines' daemons
 * report one (`pi --list-models`, `daemonState.piModels`). When the caller
 * passes `machines`, that table becomes the machine's catalog and wins over any
 * pi session on it — it is re-probed when pi or its config changes, while a
 * session's list is frozen at its start. Everything that picks a model for pi
 * (new session, Settings, Issues, Teams) therefore goes through here, exactly
 * like the other agents.
 */
export type MachineCatalogSource = { id: string; daemonState?: unknown };

export function collectRecentCatalogs(
    sessions: readonly LauncherCatalogSource[],
    flavor: string | null | undefined,
    machineId?: string | null,
    machines: readonly MachineCatalogSource[] = [],
): Metadata[] {
    const agent = normalizeAgentKey(flavor);
    const seenMachines = new Set<string>();
    const out: Metadata[] = [];
    if (agent === 'pi') {
        for (const machine of machines) {
            if (machineId && machine.id !== machineId) continue;
            const reported = piCatalogFromMachine(readPiModelTable(machine.daemonState), flavor, machine.id);
            if (!reported?.models?.length) continue;
            // A models.json fallback lacks pi's built-in providers: that machine's
            // newest pi session list is added below as well.
            if (!isPartialPiCatalog(reported)) seenMachines.add(machine.id);
            out.push(reported as unknown as Metadata);
        }
    }
    const started = (session: LauncherCatalogSource) => session.createdAt ?? session.updatedAt;
    for (const session of [...sessions].sort((a, b) => started(b) - started(a))) {
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
        configuredModel: catalog?.configuredModel,
        longContextUnsupported: !!readLongContextUnsupported(catalog?.longContextUnsupported),
    };
}

export type LauncherModelSource = { context: LauncherMachineContext | null; catalogs: Metadata[] };

/**
 * QA26 P2-7: the model keys these catalogs can run (catalogRunnableKeys: plus
 * pinned Opus 5.5, `[1m]`-only bases and Codex's gpt-6 generation) — what lets Settings fold
 * an old version (Sonnet 5) that no machine runs as its family's newest.
 * Null with no catalog: nothing proves what runs, nothing is folded for it.
 */
export function runnableFromCatalogs(flavor: string | null | undefined, catalogs: readonly Metadata[]): ReadonlySet<string> | null {
    const codes = catalogs.flatMap((catalog) => (catalog.models ?? []).map((model) => model.code));
    if (codes.length === 0) return null;
    return catalogRunnableKeys(normalizeAgentKey(flavor), codes);
}
