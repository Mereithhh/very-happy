import { storage } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import type { Status } from '@/ui';

export function useSocketStatus() {
  return storage(useShallow((s) => s.socketStatus));
}

export function useDataReady() {
  return storage(useShallow((s) => s.isDataReady));
}

/** Map raw socket status → the unified 4-state StatusDot vocabulary. */
export function socketToStatus(s: 'disconnected' | 'connecting' | 'connected' | 'error'): Status {
  switch (s) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'thinking';
    default:
      return 'offline';
  }
}
