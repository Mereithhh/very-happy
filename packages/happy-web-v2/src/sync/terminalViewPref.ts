/**
 * terminalViewPref — pure rules for the B-105 two-level terminal view
 * preference (M-3③). No zustand / network imports so every rule is
 * unit-testable (repo convention: termWriteHold / boardTaskOps precedent).
 *
 * Model: a mirrored web terminal has two faces — the raw xterm pane and the
 * structured (chat-rendered) mirror session. Which face a terminal opens with
 * is resolved as: per-terminal override (localSettings.terminalViewOverrides,
 * keyed by terminalId) → device default (localSettings.terminalViewDefault)
 * → 'xterm'. Overrides are stored as PLAIN strings (a junk value must never
 * fail the whole-blob localSettings safeParse), so validation lives here.
 *
 * Growth bound: overrides are pruned against daemonState.closedTerminals —
 * a terminal that ended no longer needs its override (terminalSync calls
 * pruneTerminalViewOverrides on every applied push).
 */

export type TerminalView = 'xterm' | 'structured';

function asView(v: unknown): TerminalView | undefined {
  return v === 'xterm' || v === 'structured' ? v : undefined;
}

/** Which face this terminal should show: override → device default → xterm. */
export function resolveTerminalView(
  defaultView: unknown,
  overrides: Record<string, string> | undefined,
  terminalId: string | undefined,
): TerminalView {
  if (terminalId && overrides) {
    const o = asView(overrides[terminalId]);
    if (o) return o;
  }
  return asView(defaultView) ?? 'xterm';
}

/**
 * Record an explicit toggle for one terminal. Always stores the choice (even
 * when it equals the device default): the user's per-terminal intent must
 * survive a later change of the default. Returns the SAME object when the
 * stored value is already the requested one, so callers can cheap-compare.
 */
export function withTerminalViewOverride(
  overrides: Record<string, string>,
  terminalId: string,
  view: TerminalView,
): Record<string, string> {
  if (overrides[terminalId] === view) return overrides;
  return { ...overrides, [terminalId]: view };
}

/**
 * Drop overrides for terminals that have ENDED (their ids appear in some
 * machine's closedTerminals records). Deliberately keyed on closed records —
 * not on absence from the live list — because machines push independently:
 * a terminal whose machine's push hasn't arrived yet must not lose its
 * override. Returns the SAME object when nothing was removed.
 */
export function pruneTerminalViewOverrides(
  overrides: Record<string, string>,
  closedTerminalIds: ReadonlySet<string>,
): Record<string, string> {
  let changed = false;
  const next: Record<string, string> = {};
  for (const [id, v] of Object.entries(overrides)) {
    if (closedTerminalIds.has(id)) {
      changed = true;
      continue;
    }
    next[id] = v;
  }
  return changed ? next : overrides;
}
