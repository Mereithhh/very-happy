/**
 * termPresetPaste — prepare a prompt preset's text for pasting into the pty.
 *
 * The insertion channel is the renderer's paste() (same as quick commands and
 * upload-path pastes): inside a bracketed-paste-aware TUI (Claude Code) a
 * multi-line paste arrives wrapped in \x1b[200~ … \x1b[201~ and is received as
 * ONE input — nothing executes until the user presses Enter. But xterm only
 * wraps when the APPLICATION enabled bracketed paste: in a plain shell the
 * paste is sent raw with every newline converted to \r, where a TRAILING
 * newline would execute the line immediately. Normalizing here keeps the
 * "text lands in the input, the user presses Enter" invariant on every paste
 * path:
 *   - CRLF / lone CR → LF (xterm's paste converts LF; don't hand it \r\n),
 *   - trailing whitespace (incl. trailing newlines) stripped — a preset's
 *     trailing newline must never double as an auto-submit,
 *   - inner newlines/indentation preserved (multi-line prompts stay intact).
 *
 * Returns '' for whitespace-only presets — callers skip the paste entirely.
 */
export function presetPasteText(raw: string): string {
    return raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}
