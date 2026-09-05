/**
 * Closed-terminal records (B-084) — pure parsing + row building, no zustand /
 * network imports so every rule is unit-testable.
 *
 * New daemons append `{id, title, cwd, closedAt}` to
 * `daemonState.closedTerminals` (next to webTerminals, same pushes; capped at
 * 20 per machine, newest first) whenever a terminal ends — web-initiated
 * close or tmux-side exit alike. The sidebar's archive view renders them as
 * "已结束终端", each with one action: open a NEW terminal in the same cwd
 * (where `claude --resume` picks the old conversation back up).
 *
 * Compatibility: an old daemon simply never writes the field → [] → the
 * archive section doesn't render. Nothing here is trusted blindly — the
 * value comes off the wire from a daemon of unknown version, so items are
 * validated one by one and malformed ones dropped.
 */

/** One closed-terminal record as pushed by the daemon. */
export interface ClosedTerminal {
  id: string;
  title?: string;
  cwd?: string;
  closedAt: number;
  /** B-105: shadow mirror session id — the terminal is gone, but its
   *  structured history stays reachable at /session/<mirrorSessionId>. */
  mirrorSessionId?: string;
  /** B-149: the claude conversation that ran inside the terminal. Present →
   *  the row can CONTINUE it (new terminal in cwd + `claude --resume <id>`)
   *  instead of only opening an empty shell there. */
  claudeSessionId?: string;
  /** B-149: 'daemon-gap' = the terminal died while no daemon was watching
   *  (daemon restart / machine reboot), so the row is labelled accordingly.
   *  Absent (old daemons) reads as an ordinary observed close. */
  reason?: 'closed' | 'daemon-gap';
  /** B-265: tags + manual-rename flag at close time (new daemons only). */
  tags?: string[];
  manual?: boolean;
}

/** B-265: does this machine's CURRENT daemon answer `restore-terminal`?
 *  Same trust rule as webTerminals: the flag must have been stamped by this
 *  daemon run (`detectedAt >= startedAt`) — a downgraded daemon spreads the
 *  stale field forward on connect. Calling an unregistered RPC would make the
 *  server wait its 15 s grace before failing, so never guess. */
export function terminalRestoreSupported(daemonState: any): boolean {
  return daemonRpcFlagSupported(daemonState, 'terminalRestore');
}

/** Generic form of the rule above for any `{ rpcAvailable, detectedAt }`
 *  capability flag the daemon stamps at connect time. */
export function daemonRpcFlagSupported(daemonState: any, key: string): boolean {
  const flag = daemonState?.[key];
  if (!flag || flag.rpcAvailable !== true || typeof flag.detectedAt !== 'number') return false;
  const startedAt = typeof daemonState.startedAt === 'number' ? daemonState.startedAt : 0;
  return flag.detectedAt >= startedAt;
}

/** B-273: does this machine's CURRENT daemon answer `list-tmux-sessions` and
 *  honour `open-terminal.attachTmux`? */
export function tmuxSessionsSupported(daemonState: any): boolean {
  return daemonRpcFlagSupported(daemonState, 'tmuxSessions');
}

/** B-290: does this machine's CURRENT daemon answer `claude-list-history`
 *  (import a Claude Code conversation that was never started through
 *  very-happy)? */
export function claudeHistorySupported(daemonState: any): boolean {
  return daemonRpcFlagSupported(daemonState, 'claudeHistory');
}

/** B-282: does `kill-terminal` honour `alsoAttached` on this daemon run? */
export function killAttachedSupported(daemonState: any): boolean {
  return daemonRpcFlagSupported(daemonState, 'tmuxSessions') && daemonState?.tmuxSessions?.killAttached === true;
}

/** Claude session ids are uuids. Validated here because the value comes off the
 *  wire and ends up inside a shell command (`claude --resume <id>`) on the
 *  machine — the web must never forward an unvalidated string into that. */
const CLAUDE_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_SESSION_ID_RE.test(value);
}

/** The startup command that continues one claude conversation, or undefined
 *  when the id is missing/malformed. The ONLY place this string is built. */
export function resumeStartupCommand(claudeSessionId: string | undefined): string | undefined {
  return isClaudeSessionId(claudeSessionId) ? `claude --resume ${claudeSessionId}` : undefined;
}

/** Tolerant read of one machine's daemonState.closedTerminals. */
export function closedTerminalsOf(daemonState: any): ClosedTerminal[] {
  const raw = daemonState?.closedTerminals;
  if (!Array.isArray(raw)) return [];
  const out: ClosedTerminal[] = [];
  for (const item of raw) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
    if (typeof item.closedAt !== 'number') continue;
    out.push({
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title : undefined,
      cwd: typeof item.cwd === 'string' && item.cwd ? item.cwd : undefined,
      closedAt: item.closedAt,
      mirrorSessionId:
        typeof item.mirrorSessionId === 'string' && item.mirrorSessionId
          ? item.mirrorSessionId
          : undefined,
      claudeSessionId: isClaudeSessionId(item.claudeSessionId) ? item.claudeSessionId : undefined,
      reason: item.reason === 'daemon-gap' || item.reason === 'closed' ? item.reason : undefined,
      ...(Array.isArray(item.tags)
        ? { tags: (item.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0) }
        : {}),
      ...(item.manual === true ? { manual: true } : {}),
    });
  }
  return out;
}

/** What the archive view renders for one ended terminal. */
export interface ClosedTerminalRow {
  /** Render key, unique across machines. */
  key: string;
  terminalId: string;
  machineId: string;
  machineName: string;
  /** Record title, falling back to the machine name (same fallback the live
   *  terminal rows use). */
  title: string;
  cwd?: string;
  closedAt: number;
  /** Whether "new terminal in this directory" can work right now. */
  machineOnline: boolean;
  /** B-105: structured history target, when the terminal had a mirror. */
  mirrorSessionId?: string;
  /** B-149: present → the row's primary action continues this conversation. */
  claudeSessionId?: string;
  /** B-149: the terminal died in a daemon/machine restart, not in an observed
   *  close — worth saying in the UI, since the user never closed it. */
  fromDaemonGap: boolean;
  /** B-265: tags shown on the row and restored with it. */
  tags?: string[];
  manual?: boolean;
  /** B-265: the machine's current daemon can restore this terminal in place
   *  (same id). false → the row falls back to "new terminal in this cwd". */
  restoreSupported: boolean;
}

/** The slice of a machine this module needs (kept narrow for tests). */
export interface ClosedRowMachine {
  id: string;
  name: string;
  online: boolean;
  daemonState: any;
}

/**
 * Merge every machine's closed records into the rows the archive view
 * renders: parse (tolerantly), drop records whose terminal is LIVE again
 * (a closed row must never coexist with a live row of the same id), keep ONE
 * row per terminal id (B-360), sort by closedAt newest-first across machines.
 * Machines are annotated by name on each row rather than grouped — the list is
 * short (≤20 per machine) and usually single-machine.
 *
 * B-360, the same-host duplicate: terminal ids are unique per HOST, and one
 * host can hold several machine rows (the machine id lives in a file that an
 * auto-update handover managed to rotate). Both rows then carry close records
 * for the same terminals, and keying rows by (machine, terminal) showed the
 * archive twice over. Newest `closedAt` wins — the last daemon to actually
 * observe the close is the one that saw it die.
 */
export function buildClosedTerminalRows(
  machines: ClosedRowMachine[],
  liveTerminalIds: ReadonlySet<string>,
): ClosedTerminalRow[] {
  const byTerminal = new Map<string, ClosedTerminalRow>();
  for (const m of machines) {
    for (const r of closedTerminalsOf(m.daemonState)) {
      if (liveTerminalIds.has(r.id)) continue;
      const held = byTerminal.get(r.id);
      if (held && held.closedAt >= r.closedAt) continue;
      byTerminal.set(r.id, {
        key: `ct:${m.id}:${r.id}`,
        terminalId: r.id,
        machineId: m.id,
        machineName: m.name,
        title: r.title || m.name || 'Terminal',
        cwd: r.cwd,
        closedAt: r.closedAt,
        machineOnline: m.online,
        mirrorSessionId: r.mirrorSessionId,
        claudeSessionId: r.claudeSessionId,
        fromDaemonGap: r.reason === 'daemon-gap',
        tags: r.tags,
        manual: r.manual,
        restoreSupported: terminalRestoreSupported(m.daemonState),
      });
    }
  }
  const rows = [...byTerminal.values()];
  rows.sort((a, b) => b.closedAt - a.closedAt);
  return rows;
}
