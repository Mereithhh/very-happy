/**
 * B-868: a web terminal's Very Happy project — the tmux user option
 * `@vh_project` holding a project id (`specs/2026-10-projects.md` §3: Web
 * terminals get ownership and display only, never injection). Pure; shared by
 * the list parser, the persisted snapshots and the RPC handler.
 */

/** A project id as the server mints it (a UUID) — conservatively any
 * short token of letters, digits, `-` and `_`. The daemon never checks that the
 * project exists (it cannot see the account's projects); the Web ignores an id
 * it does not know, so a deleted project simply stops showing the terminal. */
const TERMINAL_PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate a `set-terminal-project` / create input: an id, or null to clear.
 * undefined = invalid input (distinct from a valid "no project"). */
export function validateTerminalProjectId(value: unknown): string | null | undefined {
    if (value === null) return null;
    return typeof value === 'string' && TERMINAL_PROJECT_ID_RE.test(value) ? value : undefined;
}

/** Local tmux state is user-editable: anything but a valid id reads as none. */
export function parseTerminalProjectId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    return validateTerminalProjectId(raw.trim()) ?? null;
}
