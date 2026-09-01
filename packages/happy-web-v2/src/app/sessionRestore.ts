/**
 * sessionRestore (B-265) — the store + action side of restoring an archived
 * chat session in place. Rules live in sessionRestoreRules.ts (pure).
 */
import { create } from 'zustand';
import { storage } from '@/sync/storage';
import { machineResumeSession } from '@/sync/ops';
import { releaseSessionInactive } from '@/sync/sessionArchiveHold';
import {
  advanceRestoreState,
  mapResumeError,
  restoreEligibility,
  RESTORE_RPC_TIMEOUT_MS,
  type RestoreState,
} from './sessionRestoreRules';

export * from './sessionRestoreRules';

interface RestoreStore {
  states: Record<string, RestoreState>;
  set: (id: string, state: RestoreState | null) => void;
}

export const useSessionRestore = create<RestoreStore>((set) => ({
  states: {},
  set: (id, state) => set((s) => {
    const states = { ...s.states };
    if (state) states[id] = state;
    else delete states[id];
    return { states };
  }),
}));

export function useRestoreState(sessionId: string): RestoreState | undefined {
  return useSessionRestore((s) => s.states[sessionId]);
}

let ticker: ReturnType<typeof setInterval> | null = null;
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    const { states, set } = useSessionRestore.getState();
    let awaiting = false;
    for (const [id, st] of Object.entries(states)) {
      if (st.phase !== 'awaiting-online') continue;
      const next = advanceRestoreState(st, storage.getState().sessions[id], now);
      if (next !== st) set(id, next);
      if (next?.phase === 'awaiting-online') awaiting = true;
    }
    if (!awaiting && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 500);
}

/** Restore one archived session. Resolves true when the daemon accepted the
 *  resume (the session then comes online within a few seconds); false with
 *  the failure recorded in the store. Idempotent while a restore is running. */
export async function restoreSession(sessionId: string): Promise<boolean> {
  const store = useSessionRestore.getState();
  const current = store.states[sessionId];
  if (current && current.phase !== 'failed') return false;
  const session = storage.getState().sessions[sessionId];
  if (!session) return false;
  const eligibility = restoreEligibility(session, storage.getState().machines);
  if (!eligibility.ok) {
    store.set(sessionId, { phase: 'failed', startedAt: Date.now(), reason: eligibility.reason });
    return false;
  }
  // Drop the 5 s post-archive activity hold BEFORE the RPC, so the resumed
  // process's first heartbeat isn't suppressed.
  releaseSessionInactive(sessionId);
  const startedAt = Date.now();
  store.set(sessionId, { phase: 'spawning', startedAt });
  const result = await machineResumeSession(
    { machineId: eligibility.machineId, sessionId },
    { timeoutMs: RESTORE_RPC_TIMEOUT_MS },
    // A non-archived (merely offline) session must not be re-archived on a
    // resume failure — skip the unarchive/rearchive dance for it.
    { skipArchiveDance: session.archivedAt == null },
  );
  if (result.type === 'success') {
    useSessionRestore.getState().set(sessionId, { phase: 'awaiting-online', startedAt });
    ensureTicker();
    return true;
  }
  const message = result.type === 'error' ? result.errorMessage : 'Directory approval is not supported for resume';
  useSessionRestore.getState().set(sessionId, { phase: 'failed', startedAt, reason: mapResumeError(message), message });
  return false;
}

export function clearRestoreState(sessionId: string): void {
  useSessionRestore.getState().set(sessionId, null);
}

export function resetSessionRestoreForTest(): void {
  useSessionRestore.setState({ states: {} });
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
