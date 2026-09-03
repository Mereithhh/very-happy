/**
 * Pure query builder for the fresh-create terminal navigation (no stores, no
 * DOM — unit-tested). Kept apart from newTerminal.ts, which imports the
 * storage store at module load.
 */
import { isClaudeSessionId } from '@/sync/closedTerminals';
import { isStartupSelectionId, STARTUP_DEFAULT_ID } from '@/utils/terminalStartup';

export interface CreateTerminalOptions {
  cwd?: string;
  /** B-149: continue this claude conversation (uuid only; see above). */
  resumeClaudeSessionId?: string;
  /** B-273: create the terminal attached to the user's own tmux session. Only
   *  the tmux session id (`$N`) and its name travel in the URL — the daemon
   *  re-validates both and composes the attach command itself, so a crafted
   *  URL can at most name a session that must already exist. */
  attachTmux?: { id: string; name: string };
  /** B-334: which saved startup command this create should run. An ID only —
   *  never the command text (see utils/terminalStartup.ts). Omitted for the
   *  default, so an unchanged flow produces the exact same URL as before. */
  startupSelectionId?: string;
}

/** The `?…` query for a fresh-create navigation. Pure; unit-tested. */
export function newTerminalSearch(terminalId: string, opts: CreateTerminalOptions = {}): URLSearchParams {
  const q = new URLSearchParams({ tid: terminalId, fresh: '1' });
  if (opts.attachTmux) {
    // Attach wins over cwd/resume: the directory is irrelevant inside the
    // attached session and a resume would be typed into the wrong shell.
    q.set('attach', opts.attachTmux.id);
    q.set('attachName', opts.attachTmux.name);
    return q;
  }
  if (opts.cwd) q.set('cwd', opts.cwd);
  if (isClaudeSessionId(opts.resumeClaudeSessionId)) q.set('resume', opts.resumeClaudeSessionId);
  // `resume` already overrides the startup command for this one open, so a
  // selection alongside it would be dead weight in the URL.
  if (
    !q.has('resume')
    && opts.startupSelectionId
    && opts.startupSelectionId !== STARTUP_DEFAULT_ID
    && isStartupSelectionId(opts.startupSelectionId)
  ) {
    q.set('cmd', opts.startupSelectionId);
  }
  return q;
}

