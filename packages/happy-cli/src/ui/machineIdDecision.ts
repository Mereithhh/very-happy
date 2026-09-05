/**
 * B-360 — when may this CLI mint a NEW machine id?
 *
 * The machine id is a `randomUUID()` living in `~/.happy/settings.json`, and it
 * is the only thing tying this host to its row on the server. Losing it is not
 * a recoverable local glitch: the daemon registers a second Machine row, the
 * old row keeps its last `daemonState` (which the web renders on purpose, so
 * offline machines still show their terminals), and from then on every terminal
 * on that host appears TWICE in the web, on every device, with no user-facing
 * way to make it stop. That happened on 2026-09-04: a machine handed over from
 * CLI 0.2.118 to 0.2.119 and came back one second later under a new id.
 *
 * The old rule was `newAuth || !settings.machineId` — read against a
 * `readSettings()` that returns defaults for BOTH "no settings file" and "I
 * could not read the settings file". So a single transient read failure was
 * indistinguishable from a fresh install, and minted (and persisted) a new
 * identity. This module makes the third case explicit and refuses it: not
 * knowing whether an id exists is never a licence to replace it.
 *
 * Pure, so the rule is unit-testable without touching a filesystem.
 */

/** The settings read, narrowed to what this decision needs. Mirrors
 *  `persistence.SettingsReadOutcome` structurally so the caller can pass it
 *  straight in. */
export type MachineIdSettingsRead =
  | { kind: 'absent' }
  | { kind: 'ok'; settings: { machineId?: string } }
  | { kind: 'unreadable'; error: string };

export type MachineIdDecision =
  | { action: 'reuse'; machineId: string }
  | { action: 'mint'; reason: 'no-settings-file' | 'no-machine-id' | 'new-auth' }
  | { action: 'refuse'; reason: string };

export function decideMachineId(input: {
  read: MachineIdSettingsRead;
  /** A login just happened in this process — the account may be a different
   *  one, so the old id must not be carried over. */
  newAuth: boolean;
}): MachineIdDecision {
  const { read, newAuth } = input;

  // Unreadable beats everything, including newAuth: minting here would write a
  // fresh settings file over one whose contents we never saw.
  if (read.kind === 'unreadable') {
    return {
      action: 'refuse',
      reason:
        `settings exist but could not be read (${read.error}); refusing to mint a new machine id — ` +
        'fix or remove the settings file, or run `very-happy auth login --force` to deliberately re-register this machine',
    };
  }

  if (newAuth) return { action: 'mint', reason: 'new-auth' };
  if (read.kind === 'absent') return { action: 'mint', reason: 'no-settings-file' };

  const existing = read.settings.machineId;
  if (typeof existing === 'string' && existing.length > 0) {
    return { action: 'reuse', machineId: existing };
  }
  return { action: 'mint', reason: 'no-machine-id' };
}
