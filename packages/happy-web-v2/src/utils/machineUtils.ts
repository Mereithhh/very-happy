import type { Machine } from '@/sync/storageTypes';

export function isMachineOnline(machine: Machine): boolean {
    // Use the active flag directly, no timeout checks
    return machine.active;
}

export type TerminalMachineState = {
    available: boolean;
    status: 'connected' | 'offline';
    needsDaemonStart: boolean;
};

/** Presentation/interaction state for a machine in the terminal picker. */
export function terminalMachineState(machine: Machine): TerminalMachineState {
    const available = isMachineOnline(machine);
    return {
        available,
        status: available ? 'connected' : 'offline',
        needsDaemonStart: !available,
    };
}

/** Display label for a machine, mirroring the terminal picker's rendering. */
export function machineLabel(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8);
}

/**
 * "Skip the picker?" decision for new-terminal entry points: exactly ONE
 * machine is online → that machine (create the terminal directly); zero or
 * several online → null (send the user to the machine picker instead).
 */
export function soleOnlineMachine(machines: Machine[]): Machine | null {
    const online = machines.filter(isMachineOnline);
    return online.length === 1 ? online[0] : null;
}

/**
 * Which machine a create dialog should preselect: the one already chosen when
 * it is still online, otherwise the first online machine, otherwise ''.
 *
 * Lives here (not in a dialog) because BOTH create dialogs need it for the same
 * reason — `useAllMachines` answers [] until the store is hydrated (see
 * storage.ts's `!isDataReady` guard), so a `useState` initializer freezes the
 * selection at '' and the dialog's Create button never enables (B-146 in the
 * terminal dialog, B-147 the same bug in the chat dialog). Passing the current
 * selection as `preferred` makes a re-derive idempotent — safe to call from an
 * effect on every machine-list change without fighting the user's own pick.
 */
export function pickDefaultMachineId(onlineIds: string[], preferred?: string): string {
    if (preferred && onlineIds.includes(preferred)) return preferred;
    return onlineIds[0] ?? '';
}
