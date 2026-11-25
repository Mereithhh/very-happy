import { useShallow } from 'zustand/react/shallow';
import type { Metadata } from './storageTypes';
import { storage, useMachine } from './storage';
import { collectRecentCatalogs, launcherMachineContext, type LauncherModelSource } from './launcherModels';
import { isPiAgent } from './agentDefaults';
import { piCatalogFromMachine, readPiModelTable } from './piModelTable';

const NO_CATALOGS: Metadata[] = [];

/**
 * The pending (not yet started) session's machine: versions + recent catalogs.
 * B-978: pi's table comes from the machine's daemon (`pi --list-models`), so a
 * machine that never ran a pi session still offers its models — it leads the
 * catalogs, and the session-published ones stay as the fallback for old daemons.
 */
export function useLauncherModelSource(flavor: string | null | undefined, machineId: string | null | undefined): LauncherModelSource {
    const machine = useMachine(machineId ?? '');
    const piTable = isPiAgent(flavor) ? readPiModelTable(machine?.daemonState) : null;
    const piCatalog = piCatalogFromMachine(piTable, flavor);
    const catalogs = storage(useShallow((state) => machineId
        ? collectRecentCatalogs(Object.values(state.sessions), flavor, machineId)
        : NO_CATALOGS));
    const withMachine = piCatalog
        ? [piCatalog as unknown as Metadata, ...catalogs]
        : catalogs;
    return { context: launcherMachineContext(machine, flavor, withMachine[0]), catalogs: withMachine, piTable };
}
