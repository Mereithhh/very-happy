import * as React from 'react';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineListTerminals, type MachineTerminal } from '@/sync/ops';

export interface MachineTerminalsGroup {
    machineId: string;
    machineName: string;
    terminals: MachineTerminal[];
}

/**
 * The cross-device terminal list. Each online machine is the source of truth
 * for its own live tmux terminals; we query them over the RPC relay and poll
 * so any logged-in device sees (and can reattach) every machine's terminals —
 * no per-device localStorage. Only groups with ≥1 terminal are returned.
 */
export function useMachineTerminals(): MachineTerminalsGroup[] {
    const machines = useAllMachines();
    const [groups, setGroups] = React.useState<MachineTerminalsGroup[]>([]);

    // Re-run only when the SET of online machines changes (not on every ref).
    const online = React.useMemo(() => machines.filter((m) => isMachineOnline(m)), [machines]);
    const onlineKey = online.map((m) => m.id).join(',');

    React.useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            const results = await Promise.all(online.map(async (m) => ({
                machineId: m.id,
                machineName: m.metadata?.displayName || m.metadata?.host || m.id,
                terminals: await machineListTerminals(m.id),
            })));
            if (!cancelled) setGroups(results.filter((g) => g.terminals.length > 0));
        };
        refresh();
        const iv = setInterval(refresh, 6000);
        return () => { cancelled = true; clearInterval(iv); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onlineKey]);

    return groups;
}
