/**
 * staleWrapperPolicy (B-462) — a LIVE session whose wrapper process is still
 * running older CLI code than the machine has installed.
 *
 * Why this exists: a daemon upgrade (automatic or manual) never hot-replaces
 * the wrapper of an already running session — handover deliberately leaves
 * existing wrappers alone. So a long-lived session keeps executing the code it
 * was spawned with, sometimes for weeks, and the only way to move it onto the
 * installed version is "archive → restore", which nobody discovers. Two real
 * incidents were exactly this shape: B-460 (relay direct-inbound message
 * silently dropped, runner never answers) and B-461 (idle Codex session pins
 * `codex app-server` forever) both shipped wrapper-side fixes that stale
 * sessions never picked up. A user looking at such a session sees a healthy,
 * online session that simply does not reply.
 *
 * What this is NOT: a capability gate. Per AGENTS.md constraint 14 the web
 * decides what a wrapper CAN DO from `metadata.capabilities`, never from a
 * version string. This module only produces an advisory notice and the
 * existing `restart-session` action; nothing here may gate a feature.
 *
 * Pure rules only (no store / network imports) so they unit-test in isolation;
 * the banner that renders them lives in screens/session/StaleWrapperBanner.tsx.
 */
import { isCliVersionBelow } from './cliUpdatePolicy';

/**
 * First CLI whose wrapper cannot silently swallow a message sent from the web
 * (B-460, CLI 0.2.137). Below this the session can look online and simply
 * never answer — the one symptom users report as "it's stuck", so it gets the
 * stronger wording. Above it, a lagging wrapper is merely missing newer fixes.
 */
export const WRAPPER_DELIVERY_FIX_VERSION = '0.2.137';

export interface StaleWrapperSessionLike {
  archivedAt?: number | null;
  metadata?: {
    machineId?: string;
    /** The wrapper's OWN cli version (createSessionMetadata writes
     *  packageJson.version; reconnectSession keeps the live process's value). */
    version?: string;
    flavor?: string | null;
  } | null;
}

export interface StaleWrapperMachineLike {
  active?: boolean;
  daemonState?: {
    startedWithCliVersion?: unknown;
    cliUpdate?: { currentVersion?: unknown } | null;
  } | null;
  metadata?: { happyCliVersion?: string } | null;
}

export interface StaleWrapperNotice {
  /** Version the wrapper process is running. */
  sessionVersion: string;
  /** Version the machine's daemon is running — what a restart would land on. */
  machineVersion: string;
  /** 'critical' = below the B-460 message-delivery fix. */
  severity: 'critical' | 'behind';
}

/** What the daemon is running RIGHT NOW, preferred over any published policy
 *  field: `startedWithCliVersion` is the code of the live daemon process, which
 *  is what a restarted wrapper would be spawned from. The cliUpdate/metadata
 *  fallbacks only cover daemons too old to report it. */
export function machineCliVersion(machine: StaleWrapperMachineLike | undefined | null): string | null {
  const candidates = [
    machine?.daemonState?.startedWithCliVersion,
    machine?.daemonState?.cliUpdate?.currentVersion,
    machine?.metadata?.happyCliVersion,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * The notice for one session, or null when there is nothing to say. Silent
 * whenever we cannot be sure: an archived session (the restore banner owns
 * that), a terminal mirror (it has no wrapper to restart), an offline machine
 * (restart would fail anyway), or either version missing/unparsable — a
 * version we cannot read must never be reported as "behind".
 */
export function staleWrapperNotice(
  session: StaleWrapperSessionLike | undefined | null,
  machine: StaleWrapperMachineLike | undefined | null,
): StaleWrapperNotice | null {
  if (!session || session.archivedAt != null) return null;
  if (session.metadata?.flavor === 'terminal-mirror') return null;
  if (!machine || machine.active !== true) return null;
  const sessionVersion = session.metadata?.version?.trim();
  const machineVersion = machineCliVersion(machine);
  if (!sessionVersion || !machineVersion) return null;
  if (!isCliVersionBelow(sessionVersion, machineVersion)) return null;
  return {
    sessionVersion,
    machineVersion,
    severity: isCliVersionBelow(sessionVersion, WRAPPER_DELIVERY_FIX_VERSION) ? 'critical' : 'behind',
  };
}

/** Dismissal is remembered per session AND per wrapper version: restarting the
 *  session (or a takeover) gives it a new version, and a wrapper that falls
 *  behind again later is a new fact worth surfacing once more. */
export function staleWrapperHintKey(sessionId: string, notice: Pick<StaleWrapperNotice, 'sessionVersion'>): string {
  return `stale-wrapper:${sessionId}:${notice.sessionVersion}`;
}

export function isStaleWrapperNoticeVisible(
  hintKey: string,
  dismissedHints: Readonly<Record<string, number>> | undefined,
): boolean {
  return typeof dismissedHints?.[hintKey] !== 'number';
}
