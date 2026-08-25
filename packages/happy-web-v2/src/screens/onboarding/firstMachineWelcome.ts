export interface FirstMachineConnectedEvent {
  machineId: string;
}

type FirstMachineConnectedListener = (event: FirstMachineConnectedEvent) => void;

const listeners = new Set<FirstMachineConnectedListener>();

/**
 * Ephemeral, tab-local handoff from realtime sync to onboarding UI.
 *
 * This deliberately is not persisted or synced: a reload with an existing
 * machine is not a fresh connection, and another device should not replay the
 * success dialog later.
 */
export function subscribeFirstMachineConnected(listener: FirstMachineConnectedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitFirstMachineConnected(event: FirstMachineConnectedEvent): void {
  for (const listener of listeners) listener(event);
}

export function shouldAnnounceFirstMachine(existingMachineCount: number, machineAlreadyKnown: boolean): boolean {
  return existingMachineCount === 0 && !machineAlreadyKnown;
}
