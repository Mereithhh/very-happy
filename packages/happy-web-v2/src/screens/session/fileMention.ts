/**
 * B-035: `@` file mentions in the composer. Pure, so the trigger/insert
 * matrix is unit-tested instead of verified by hand.
 *
 * Trigger (as Codex's TUI): the whitespace-delimited token under the caret
 * starts with `@` — anywhere in the message, not only at its start. `a@b`
 * (an e-mail, a decorator) never triggers; typing a space ends the token and
 * closes the list.
 *
 * Insert: the token becomes `@<path relative to cwd>` + one space, `@` kept.
 * Claude Code expands `@path` itself (file → its content, directory → a
 * listing), including `@"path with spaces"` (a backslash escape is NOT
 * understood — checked with `claude -p`); other runners receive the path as
 * plain text and read it themselves.
 */

export interface FileMentionToken {
    /** index of the `@` */
    start: number;
    /** end of the token (exclusive): the next whitespace after the caret, or the text end */
    end: number;
    /** what follows the `@`, without a leading quote */
    query: string;
}

const WS = /\s/;

export function fileMentionQuery(text: string, caret: number): FileMentionToken | null {
    if (caret < 0 || caret > text.length) return null;
    let start = caret;
    while (start > 0 && !WS.test(text[start - 1])) start--;
    if (text[start] !== '@' || start === caret) return null;
    let end = caret;
    while (end < text.length && !WS.test(text[end])) end++;
    const raw = text.slice(start + 1, end);
    if (raw.includes('@')) return null;
    return { start, end, query: raw.replace(/^"/, '').replace(/"$/, '') };
}

/** `@path`, or `@"path"` when it contains whitespace (Claude Code's form). */
export function fileMentionText(path: string): string {
    return WS.test(path) ? `@"${path}"` : `@${path}`;
}

/** Replace the token with the mention and one separating space; returns the new text and caret. */
export function applyFileMention(text: string, token: FileMentionToken, path: string): { text: string; caret: number } {
    const mention = fileMentionText(path);
    const after = text.slice(token.end);
    const spaced = after.length > 0 && WS.test(after[0]) ? after : ` ${after}`;
    const next = text.slice(0, token.start) + mention + spaced;
    return { text: next, caret: token.start + mention.length + 1 };
}

/** Key that identifies "this token, at this place" so Escape keeps it dismissed until it changes. */
export function fileMentionDismissKey(text: string, token: FileMentionToken): string {
    return `${token.start}:${text.slice(token.start, token.end)}`;
}

export const FILE_MENTION_LIMIT = 8;
