/**
 * B-361 — a machine row that a NEWER row of the same install has replaced.
 *
 * `machineId` is a `randomUUID()` written once into
 * `<happyHomeDir>/settings.json`, so one directory yields exactly one id and a
 * host normally owns exactly one row. That stops being true when the id is
 * lost: the daemon registers a SECOND row, and the first stays behind forever
 * carrying its last `daemonState` — which this app renders on purpose, because
 * that is how an offline machine still shows its terminals (see
 * sync/terminalPushOps.ts). B-360 stopped the duplicate terminal ROWS that
 * produced; what is left is the abandoned machine itself: its frozen terminal
 * list can still contribute ghost terminals the live daemon no longer has, and
 * the machine appears twice in every picker.
 *
 * The identity a superseded row shares with its replacement is
 * `host + platform + happyHomeDir`. All three must match and each must be a
 * non-empty string — a daemon that reports none of them must never be grouped
 * with anything. Two rows matching that triple can only be the same install:
 * `~/.happy` copied to a different host differs in `host`, and that case is
 * B-297's (detected daemon-side, deliberately not handled here).
 *
 * Two rules keep this from ever hiding a machine someone is using:
 *
 *   1. **An online row is never superseded.** The one shape that could collide
 *      legitimately — `~/.happy` copied to an identically named host with the
 *      same home path, then re-authenticated — leaves two LIVE rows, and
 *      hiding either would be wrong. Offline-only also means nothing here is
 *      sticky: a machine that comes back simply reappears.
 *   2. **The keeper is the most recently active row of the group**, online
 *      first, then by `activeAt`, then by id so the choice is deterministic.
 *      When every row in a group is offline the group still collapses to one —
 *      the newest — instead of showing a sleeping machine twice.
 *
 * Pure; no store or network imports, so both rules are unit-testable.
 */

/** The slice of a machine this rule needs (structural, so callers pass
 *  `Machine` straight in). */
export interface SupersedableMachine {
  id: string;
  active?: boolean;
  activeAt?: number;
  metadata?: { host?: string; platform?: string; happyHomeDir?: string } | null;
}

/**
 * The identity two rows of one install share, or null when the row does not
 * report all three parts (never group on a partial identity).
 *
 * The key is JSON rather than a joined string on purpose: a separator only
 * works while you can prove it never occurs inside a part, and "a hostname
 * cannot contain X" is the kind of assumption that is true right up until some
 * daemon reports something unexpected. JSON encodes the boundaries, so no
 * two different triples can produce one key whatever the parts contain.
 */
function identityKey(machine: SupersedableMachine): string | null {
  const meta = machine.metadata;
  if (!meta) return null;
  const parts = [meta.host, meta.platform, meta.happyHomeDir];
  if (!parts.every((p): p is string => typeof p === 'string' && p.length > 0)) return null;
  return JSON.stringify(parts);
}

/** Most recently active first: online beats offline, then `activeAt`, then id. */
function keeperFirst(a: SupersedableMachine, b: SupersedableMachine): number {
  if (!!a.active !== !!b.active) return a.active ? -1 : 1;
  const byActive = (b.activeAt ?? 0) - (a.activeAt ?? 0);
  if (byActive !== 0) return byActive;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Ids of the machine rows that a newer row of the SAME install has replaced.
 * Only ever offline rows; the keeper of each group is never included.
 */
export function supersededMachineIds(machines: readonly SupersedableMachine[]): Set<string> {
  const groups = new Map<string, SupersedableMachine[]>();
  for (const machine of machines) {
    const key = identityKey(machine);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(machine);
    else groups.set(key, [machine]);
  }

  const superseded = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [, ...rest] = [...group].sort(keeperFirst);
    for (const machine of rest) {
      if (machine.active) continue; // rule 1: never hide a live machine
      superseded.add(machine.id);
    }
  }
  return superseded;
}

/** Convenience for the common "drop them" case. Returns the SAME array when
 *  nothing is superseded, so callers that memoise on identity stay cheap. */
export function withoutSupersededMachines<M extends SupersedableMachine>(
  machines: readonly M[],
): readonly M[] {
  const superseded = supersededMachineIds(machines);
  return superseded.size === 0 ? machines : machines.filter((m) => !superseded.has(m.id));
}
