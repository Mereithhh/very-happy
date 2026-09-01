/**
 * sessionRestart (B-264 Piece 2) — the store + action side of relaunching a
 * live-but-broken chat session in place. Rules live in sessionRestartRules.ts
 * (pure). Modeled on sessionRestore.ts, but the RPC is `restart-session` and
 * there is no archive/unarchive dance — the session is live.
 */
import { create } from 'zustand';
import { storage } from '@/sync/storage';
import { machineRestartSession } from '@/sync/ops';
import {
  advanceRestartState,
  mapRestartError,
  restartEligibility,
  RESTART_RPC_TIMEOUT_MS,
  type RestartState,
} from './sessionRestartRules';

export * from './sessionRestartRules';

interface RestartStore {
  states: Record<string, RestartState>;
  set: (id: string, state: RestartState | null) => void;
}

export const useSessionRestart = create<RestartStore>((set) => ({
  states: {},
  set: (id, state) => set((s) => {
    const states = { ...s.states };
    if (state) states[id] = state;
    else delete states[id];
    return { states };
  }),
}));

export function useRestartState(sessionId: string): RestartState | undefined {
  return useSessionRestart((s) => s.states[sessionId]);
}

let ticker: ReturnType<typeof setInterval> | null = null;
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    const { states, set } = useSessionRestart.getState();
    let awaiting = false;
    for (const [id, st] of Object.entries(states)) {
      if (st.phase !== 'awaiting-online') continue;
      const next = advanceRestartState(st, storage.getState().sessions[id], now);
      if (next !== st) set(id, next);
      if (next?.phase === 'awaiting-online') awaiting = true;
    }
    if (!awaiting && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 500);
}

/** Restart one live-but-broken session. Resolves true when the daemon accepted
 *  the restart (the session then comes back online within a few seconds);
 *  false with the failure recorded in the store. Idempotent while a restart is
 *  running. */
export async function restartBrokenSession(sessionId: string): Promise<boolean> {
  const store = useSessionRestart.getState();
  const current = store.states[sessionId];
  if (current && current.phase !== 'failed') return false;
  const session = storage.getState().sessions[sessionId];
  if (!session) return false;
  const eligibility = restartEligibility(session, storage.getState().machines);
  if (!eligibility.ok) {
    store.set(sessionId, { phase: 'failed', startedAt: Date.now(), reason: eligibility.reason });
    return false;
  }
  const startedAt = Date.now();
  store.set(sessionId, { phase: 'spawning', startedAt });
  const result = await machineRestartSession(
    { machineId: eligibility.machineId, sessionId },
    { timeoutMs: RESTART_RPC_TIMEOUT_MS },
  );
  if (result.type === 'success') {
    useSessionRestart.getState().set(sessionId, { phase: 'awaiting-online', startedAt });
    ensureTicker();
    return true;
  }
  const message = result.type === 'error' ? result.errorMessage : 'Directory approval is not supported for restart';
  useSessionRestart.getState().set(sessionId, { phase: 'failed', startedAt, reason: mapRestartError(message), message });
  return false;
}

export function clearRestartState(sessionId: string): void {
  useSessionRestart.getState().set(sessionId, null);
}

export function resetSessionRestartForTest(): void {
  useSessionRestart.setState({ states: {} });
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
