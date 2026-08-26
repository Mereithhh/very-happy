/**
 * Low-latency terminal controls for alternate-screen TUIs.
 *
 * A touch gesture used to become a terminal-scroll RPC. That path is still the
 * compatibility fallback, but a TUI that explicitly requested mouse reporting
 * already told us the exact input it understands: SGR wheel reports. Sending a
 * bounded burst through the existing realtime terminal-input lane removes the
 * RPC acknowledgement and daemon-side tmux probe from every touch frame.
 */

/** Same per-step safety bound as the daemon's terminal-scroll implementation. */
export const MAX_SGR_WHEEL_EVENTS = 200;

/**
 * Encode signed terminal rows as SGR mouse-wheel reports.
 * Positive rows scroll toward older content; negative rows scroll toward the
 * live bottom. Coordinates are 1-based and aimed at the pane centre, matching
 * the daemon fallback (Claude Code accepts wheel events anywhere in the pane).
 */
export function encodeSgrWheelBurst(lines: number, cols: number, rows: number): string {
    if (!Number.isFinite(lines)) return '';
    const count = Math.min(Math.abs(Math.trunc(lines)), MAX_SGR_WHEEL_EVENTS);
    if (count === 0) return '';
    const button = lines > 0 ? 64 : 65;
    const x = Math.max(1, Math.ceil(Math.max(1, cols) / 2));
    const y = Math.max(1, Math.ceil(Math.max(1, rows) / 2));
    return `\x1b[<${button};${x};${y}M`.repeat(count);
}

/** Ctrl+End: Claude fullscreen's documented “latest + resume auto-follow”. */
export const CLAUDE_JUMP_TO_LATEST = '\x1b[1;5F';

/** Only inject an app-level jump when daemon classification says Claude. */
export function latestTuiInput(alternateBuffer: boolean, claudeLike: boolean): string {
    return alternateBuffer && claudeLike ? CLAUDE_JUMP_TO_LATEST : '';
}
