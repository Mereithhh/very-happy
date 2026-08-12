/**
 * Identifier validation for the assistant tool surface — B-051.
 *
 * Every sessionId / terminalId coming out of the model goes through these
 * before being interpolated into URLs, file lookups, or tmux targets
 * (precedent: webTerminal open/setTitle validate terminal ids the same way).
 */

/** Happy session ids are cuid-like; be conservative: URL-safe, bounded. */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

/** Same charset webTerminal.open()/scroll() accept for terminal ids. */
const TERMINAL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function isValidSessionId(id: unknown): id is string {
    return typeof id === 'string' && SESSION_ID_RE.test(id)
}

export function isValidTerminalId(id: unknown): id is string {
    return typeof id === 'string' && TERMINAL_ID_RE.test(id)
}
