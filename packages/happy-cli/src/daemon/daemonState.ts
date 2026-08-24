import type { DaemonLocallyPersistedState } from '@/persistence';

/** Build the heartbeat rewrite without dropping security- or version fields. */
export function withDaemonHeartbeat(
  state: DaemonLocallyPersistedState,
  lastHeartbeat: string,
): DaemonLocallyPersistedState {
  return { ...state, lastHeartbeat };
}
