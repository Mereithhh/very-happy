import { useShallow } from 'zustand/react/shallow';
import type { Metadata } from './storageTypes';
import { storage, useMachine } from './storage';
import { collectRecentCatalogs, launcherMachineContext, type LauncherModelSource } from './launcherModels';

const NO_CATALOGS: Metadata[] = [];

/**
 * The pending (not yet started) session's machine: versions + recent catalogs.
 * B-978: pi's catalog on that machine is the table its daemon reports
 * (`pi --list-models`), so a machine that never ran a pi session still offers
 * its models — `collectRecentCatalogs` inserts it in place of a session's.
 */
export function useLauncherModelSource(flavor: string | null | undefined, machineId: string | null | undefined): LauncherModelSource {
    const machine = useMachine(machineId ?? '');
    const catalogs = storage(useShallow((state) => machineId
        ? collectRecentCatalogs(Object.values(state.sessions), flavor, machineId, machine ? [machine] : [])
        : NO_CATALOGS));
    return { context: launcherMachineContext(machine, flavor, catalogs[0]), catalogs };
}
