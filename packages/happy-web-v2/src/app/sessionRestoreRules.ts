/**
 * sessionRestore (B-265) — bring an ARCHIVED chat session back to life in
 * place: same happy session id, same URL, history intact. The mechanism is
 * the daemon's `resume-happy-session` RPC (spawns `claude --resume` with the
 * HAPPY_RECONNECT_* identity); this module owns the web side of it:
 *
 *   eligibility (pure)  →  restoreSession()  →  await presence online (2 s)
 *
 * Only `archivedAt != null` sessions are restorable here. An inactive session
 * WITHOUT archivedAt merely went offline (10-min heartbeat timeout); its
 * process is expected to reconnect on its own and sending to it keeps working
 * exactly as before — never intercept that path.
 *
 * This file holds the PURE rules (no store / network imports — unit-tested
 * in isolation); the store + the restore action live in sessionRestore.ts.
 */
import type { Machine, Session } from '@/sync/storageTypes';

export type RestoreReason =
  | 'not-archived'
  | 'no-machine'
  | 'machine-offline'
  | 'unsupported-flavor'
  | 'no-backend-id'
  | 'not-tracked'
  | 'missing-cwd'
  | 'conversation-missing'
  | 'machine-unreachable'
  | 'timeout'
  | 'unknown';

export type RestorePhase = 'spawning' | 'awaiting-online' | 'failed';

export interface RestoreState {
  phase: RestorePhase;
  /** When the restore was requested (ms). */
  startedAt: number;
  /** First tick at which presence read 'online' while awaiting. */
  onlineSince?: number;
  reason?: RestoreReason;
  /** Raw daemon / transport text for the `unknown` reason. */
  message?: string;
}

/** Presence must hold 'online' this long before the session counts as
 *  ready: the CLI's first keepAlive fires on construction, slightly before
 *  its message fetch is armed. */
export const RESTORE_ONLINE_GRACE_MS = 2_000;
/** Give up waiting for presence after the RPC succeeded. */
export const RESTORE_AWAIT_ONLINE_TIMEOUT_MS = 30_000;
/** After this long in `spawning` the UI says "machine not responding". */
export const RESTORE_SLOW_SPAWN_MS = 15_000;
/** RPC ceiling: server-side RPC timeout (30 s) + margin. */
export const RESTORE_RPC_TIMEOUT_MS = 35_000;

export type EligibilitySession = Pick<Session, 'active' | 'archivedAt' | 'metadata'>;
export type EligibilityMachine = Pick<Machine, 'id' | 'active'>;

/** Whether the web can even ask the machine to restore this session. Only
 *  checks what the web can know; everything else is the daemon's verdict
 *  (see mapResumeError). */
export function restoreEligibility(
  session: EligibilitySession,
  machines: Record<string, EligibilityMachine>,
): { ok: true; machineId: string } | { ok: false; reason: RestoreReason } {
  // B-264/session-recoverability: an inactive session is recoverable whether it
  // was user-archived OR just went offline (its wrapper may have died with the
  // machine and will NOT auto-return). archivedAt is a label, not a gate here.
  const flavor = session.metadata?.flavor ?? 'claude';
  if (flavor !== 'claude' && flavor !== 'codex') return { ok: false, reason: 'unsupported-flavor' };
  const backendId = flavor === 'codex' ? session.metadata?.codexThreadId : session.metadata?.claudeSessionId;
  if (!backendId) return { ok: false, reason: 'no-backend-id' };
  const machineId = session.metadata?.machineId;
  if (!machineId || !machines[machineId]) return { ok: false, reason: 'no-machine' };
  // isMachineOnline = the active flag (utils/machineUtils); inlined to keep
  // this module free of store imports.
  if (!machines[machineId].active) return { ok: false, reason: 'machine-offline' };
  return { ok: true, machineId };
}

/** composerGate ONLY: an ARCHIVED offline session's composer restores first;
 *  a merely-offline (non-archived) session's composer sends as today. Must stay
 *  archivedAt-gated — do NOT reuse for button visibility (use canOfferRestore). */
export function isRestorable(session: EligibilitySession | null | undefined): boolean {
  return !!session && !session.active && session.archivedAt != null;
}

/** Whether a row / banner / palette should OFFER the restore action — archivedAt
 *  independent (offline-but-not-archived sessions are recoverable too). Does NOT
 *  require the machine online: an offline machine still shows the action, DISABLED
 *  with a "waiting for machine" reason (compute enabled/disabled from
 *  restoreEligibility, whose only remaining rejection for a canOfferRestore=true
 *  session is machine-offline). `machine` must be the session's own machine. */
export function canOfferRestore(
  session: EligibilitySession | null | undefined,
  machine: EligibilityMachine | null | undefined,
): boolean {
  if (!session || session.active) return false;
  const flavor = session.metadata?.flavor ?? 'claude';
  if (flavor !== 'claude' && flavor !== 'codex') return false;
  const backendId = flavor === 'codex' ? session.metadata?.codexThreadId : session.metadata?.claudeSessionId;
  if (!backendId) return false;
  return !!machine; // machine-known; machine-offline → shown but disabled
}

/** Daemon / transport error text → user-facing reason. New CLIs prefix
 *  precheck failures with `resume-precheck:<reason>`; older ones only have
 *  free text, matched loosely here. */
export function mapResumeError(text: string | undefined | null): RestoreReason {
  const s = (text ?? '').trim();
  const prefixed = /^resume-precheck:([a-z-]+)/.exec(s);
  if (prefixed) {
    const r = prefixed[1];
    if (r === 'not-tracked' || r === 'no-encryption' || r === 'no-metadata') return 'not-tracked';
    if (r === 'no-backend-id') return 'no-backend-id';
    if (r === 'unsupported-flavor') return 'unsupported-flavor';
    if (r === 'missing-cwd') return 'missing-cwd';
    if (r === 'conversation-missing') return 'conversation-missing';
    return 'unknown';
  }
  const lower = s.toLowerCase();
  if (lower.includes('not tracked by this daemon') || lower.includes('no stored encryption data') || lower.includes('has no metadata')) return 'not-tracked';
  if (lower.includes('missing its claude session id') || lower.includes('missing its codex thread id')) return 'no-backend-id';
  if (lower.includes('unsupported flavor')) return 'unsupported-flavor';
  if (lower.includes('enoent')) return 'missing-cwd';
  if (lower.includes('rpc method not available') || lower.includes('rpc target disconnected') || lower.includes('method not found') || lower.includes('timeout') || lower.includes('timed out')) return 'machine-unreachable';
  return 'unknown';
}

/** One tick of the wait-for-online state machine. Returns null when the
 *  restore is complete (state entry should be dropped). */
export function advanceRestoreState(
  state: RestoreState,
  session: Pick<Session, 'presence'> | undefined,
  now: number,
): RestoreState | null {
  if (state.phase !== 'awaiting-online') return state;
  const online = session?.presence === 'online';
  if (online) {
    const since = state.onlineSince ?? now;
    if (now - since >= RESTORE_ONLINE_GRACE_MS) return null;
    return state.onlineSince === since ? state : { ...state, onlineSince: since };
  }
  if (now - state.startedAt >= RESTORE_AWAIT_ONLINE_TIMEOUT_MS) {
    return { ...state, phase: 'failed', reason: 'timeout', onlineSince: undefined };
  }
  return state.onlineSince === undefined ? state : { ...state, onlineSince: undefined };
}

/** Composer gate (A3): an archived session's composer restores first and
 *  queues; everything else (live OR merely offline) sends as today. */
export type ComposerGate = 'send' | 'restore-first';
export function composerGate(session: EligibilitySession | null | undefined): ComposerGate {
  return isRestorable(session) ? 'restore-first' : 'send';
}

