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
import { normalizeClaudeOutboundMode } from '@/sync/permissionModeOutbound';
import { isHibernated } from './sessionHibernation';

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

export type EligibilitySession = Pick<Session, 'active' | 'archivedAt' | 'metadata'> & { activeAt?: number };
export type EligibilityMachine = Pick<Machine, 'id' | 'active'>;

/**
 * The backend id a resume reopens: Claude session / Codex thread, or (B-633)
 * the pi session a pi wrapper recorded — pi runs on the generic `acp` flavor,
 * so only that id marks an ACP session as resumable.
 */
function resumableBackend(session: EligibilitySession): string | null | 'unsupported-flavor' {
  const flavor = session.metadata?.flavor ?? 'claude';
  if (flavor === 'acp') return session.metadata?.piSessionId ?? 'unsupported-flavor';
  if (flavor !== 'claude' && flavor !== 'codex') return 'unsupported-flavor';
  // B-680: a session that never ran a turn has no backend id yet; restoring it
  // starts its first conversation (daemon `resumeStartsFreshConversation`), so
  // it is just as recoverable. An old daemon answers `no-backend-id`.
  return (flavor === 'codex' ? session.metadata?.codexThreadId : session.metadata?.claudeSessionId) ?? NEVER_RAN;
}

const NEVER_RAN = 'never-ran';

/** B-680: an offline claude/codex session that never ran a turn. */
export function isNeverRunOffline(session: EligibilitySession | null | undefined): boolean {
  return !!session && !session.active && resumableBackend(session) === NEVER_RAN;
}

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
  const backend = resumableBackend(session);
  if (backend === 'unsupported-flavor') return { ok: false, reason: 'unsupported-flavor' };
  if (!backend) return { ok: false, reason: 'no-backend-id' };
  const machineId = session.metadata?.machineId;
  if (!machineId || !machines[machineId]) return { ok: false, reason: 'no-machine' };
  // isMachineOnline = the active flag (utils/machineUtils); inlined to keep
  // this module free of store imports.
  if (!machines[machineId].active) return { ok: false, reason: 'machine-offline' };
  return { ok: true, machineId };
}

/**
 * B-683: the permission mode a relaunch (restore / restart) must hand the
 * daemon. The relaunched wrapper starts from its `--permission-mode` flag and
 * nothing else (no flag → `default`, by design: absence never means full
 * access) and then PUBLISHES that mode, which the web adopts as truth — so a
 * relaunch without the flag silently turned 「自动执行」 into 「默认」.
 *
 * Only user intent is forwarded (permission-mode spec A3): this device's
 * explicit pick (`session.permissionMode`, null when nobody chose) and else the
 * mode the last wrapper actually ran (`metadata.permissionMode`). The code
 * default is never sent. Claude values go through the outbound allowlist; other
 * flavors forward their published mode as-is (the daemon allowlists it — B-587
 * already did this for hibernation wakes).
 */
export function relaunchPermissionMode(
  session: Pick<Session, 'metadata'> & { permissionMode?: string | null },
): string | undefined {
  const published = session.metadata?.permissionMode ?? null;
  if ((session.metadata?.flavor ?? 'claude') === 'claude') {
    return normalizeClaudeOutboundMode(session.permissionMode ?? published) ?? undefined;
  }
  return published ?? undefined;
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
  const backend = resumableBackend(session);
  if (!backend || backend === 'unsupported-flavor') return false;
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
 *  queues; so does a HIBERNATED one (B-587: it will not come back on its own)
 *  and a never-run offline one (B-680); everything else (live OR merely
 *  offline) sends as today. */
export type ComposerGate = 'send' | 'restore-first';
export function composerGate(session: EligibilitySession | null | undefined): ComposerGate {
  // B-680: so does an offline session that never ran a turn — no wrapper
  // brings it back on its own, and a plain send used to vanish without a word.
  return isRestorable(session) || isHibernated(session) || isNeverRunOffline(session) ? 'restore-first' : 'send';
}

