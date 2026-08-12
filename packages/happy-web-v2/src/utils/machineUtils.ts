import type { Machine } from '@/sync/storageTypes';

export function isMachineOnline(machine: Machine): boolean {
    // Use the active flag directly, no timeout checks
    return machine.active;
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
