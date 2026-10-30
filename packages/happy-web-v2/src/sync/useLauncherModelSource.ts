import { useShallow } from 'zustand/react/shallow';
import type { Metadata } from './storageTypes';
import { storage, useMachine } from './storage';
import { collectRecentCatalogs, launcherMachineContext, type LauncherModelSource } from './launcherModels';

const NO_CATALOGS: Metadata[] = [];

/** The pending (not yet started) session's machine: versions + recent catalogs. */
export function useLauncherModelSource(flavor: string | null | undefined, machineId: string | null | undefined): LauncherModelSource {
    const machine = useMachine(machineId ?? '');
    const catalogs = storage(useShallow((state) => machineId
        ? collectRecentCatalogs(Object.values(state.sessions), flavor, machineId)
        : NO_CATALOGS));
    return { context: launcherMachineContext(machine, flavor, catalogs[0]), catalogs };
}
