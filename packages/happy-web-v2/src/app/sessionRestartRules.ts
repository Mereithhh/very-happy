/**
 * sessionRestart (B-264 Piece 2) — relaunch a LIVE-but-broken chat session in
 * place. When an agent process fails to start the chat shows a `processFailed`
 * service event; this offers an inline "Restart" that tells the daemon to stop
 * the broken wrapper and respawn it on current CLI code (the `restart-session`
 * RPC). Unlike sessionRestore this is NOT for archived sessions — the session
 * stays live, so eligibility only checks that we know its machine and it's
 * online; everything else is the daemon's verdict.
 *
 * This file holds the PURE rules (no store / network imports — unit-tested in
 * isolation); the store + the restart action live in sessionRestartAction.ts.
 */
import type { Session } from '@/sync/storageTypes';
import {
  advanceRestoreState,
  type EligibilityMachine,
  type EligibilitySession,
  type RestoreState,
} from './sessionRestoreRules';

export {
  RESTORE_ONLINE_GRACE_MS as RESTART_ONLINE_GRACE_MS,
  RESTORE_AWAIT_ONLINE_TIMEOUT_MS as RESTART_AWAIT_ONLINE_TIMEOUT_MS,
  RESTORE_RPC_TIMEOUT_MS as RESTART_RPC_TIMEOUT_MS,
} from './sessionRestoreRules';

export type RestartReason =
  | 'no-machine'
  | 'machine-offline'
  /** The machine's daemon predates the `restart-session` RPC — its CLI must be
   *  updated before restart works from here. */
  | 'daemon-too-old'
  | 'timeout'
  | 'unknown';

export type RestartPhase = 'spawning' | 'awaiting-online' | 'failed';

export interface RestartState {
  phase: RestartPhase;
  /** When the restart was requested (ms). */
  startedAt: number;
  /** First tick at which presence read 'online' while awaiting. */
  onlineSince?: number;
  reason?: RestartReason;
  /** Raw daemon / transport text for the `unknown` / `daemon-too-old` reason. */
  message?: string;
}

/** Whether the web can even ask the machine to restart this LIVE session. A
 *  restart never touches archived sessions (those go through sessionRestore),
 *  so — unlike restoreEligibility — this does NOT gate on archivedAt: it only
 *  checks what the web can know (we have the machine and it's online). */
export function restartEligibility(
  session: EligibilitySession,
  machines: Record<string, EligibilityMachine>,
): { ok: true; machineId: string } | { ok: false; reason: RestartReason } {
  const machineId = session.metadata?.machineId;
  if (!machineId || !machines[machineId]) return { ok: false, reason: 'no-machine' };
  // isMachineOnline = the active flag (utils/machineUtils); inlined to keep
  // this module free of store imports.
  if (!machines[machineId].active) return { ok: false, reason: 'machine-offline' };
  return { ok: true, machineId };
}

/** Daemon / transport error text → user-facing reason. A daemon that predates
 *  the `restart-session` handler answers the RPC with "Method not found"
 *  (RpcHandlerManager) — the distinct `daemon-too-old` reason so the UI can
 *  say "update the machine's CLI to restart from here". */
export function mapRestartError(text: string | undefined | null): RestartReason {
  const lower = (text ?? '').trim().toLowerCase();
  if (lower.includes('method not found')) return 'daemon-too-old';
  return 'unknown';
}

/** One tick of the wait-for-online state machine — identical semantics to
 *  restore's, reused wholesale. Returns null when the restart is complete
 *  (state entry should be dropped). */
export function advanceRestartState(
  state: RestartState,
  session: Pick<Session, 'presence'> | undefined,
  now: number,
): RestartState | null {
  // advanceRestoreState is generic over the phase/timing fields we share; the
  // only reason it ever writes is 'timeout', which RestartReason also has.
  return advanceRestoreState(state as RestoreState, session, now) as RestartState | null;
}
