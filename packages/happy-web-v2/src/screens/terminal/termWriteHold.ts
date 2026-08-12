/**
 * Selection write-hold for the web terminal — extracted state machine.
 *
 * While the user drag-selects (desktop) or mobile select-mode is on, incoming
 * pty output is BUFFERED instead of written: xterm stores a selection in
 * buffer coordinates, so any output that scrolls/redraws the screen mid-drag
 * shifts different text under the highlight (a busy TUI like Claude Code
 * repaints continuously and made selection impossible). On release the caller
 * copies FIRST, then this flushes the buffered chunks in order. Chunk
 * boundaries are preserved exactly as received — xterm's UTF-8 decoder is
 * stateful across write() calls, so a multibyte char split across chunks
 * renders correctly after a flush.
 *
 * ── Why this is a state machine with several release paths (regression) ────
 * The first version armed the hold on EVERY host mousedown and released it
 * only on document mouseup / window blur. On macOS Chrome a right-click (or
 * ctrl-click) opens the NATIVE context menu at mousedown and the matching
 * mouseup is swallowed by the menu — the hold stuck, ALL terminal output
 * froze, and typing looked dead: committed IME text (Chinese) never echoed
 * while the local pinyin bubble still worked, reading as "中文输入法坏了"
 * (right-click → paste → type is a common flow). Defense in depth:
 *
 *  1. only the PRIMARY button arms the gesture hold (a right-click drag never
 *     selects anyway — xterm's rightClickSelectsWord acts at mousedown);
 *  2. `contextmenu` ends the gesture (covers platform quirks where a primary-
 *     button flow still opens a menu);
 *  3. a mousemove with no buttons pressed while the gesture hold is active
 *     means the mouseup was lost — release (self-heals after any menu/dialog);
 *  4. user INPUT releases a stuck gesture hold (`noteUserInput` from the
 *     send-input path): nobody types mid-drag on purpose, and a stuck hold
 *     eating the echo of what you type is the worst failure mode. Typing —
 *     including an IME commit or a context-menu paste — therefore always
 *     unfreezes the screen even if a release path above was missed.
 *
 * Two independent hold owners:
 *  - the mouse GESTURE (desktop drag-select), released by the paths above;
 *  - select-MODE (mobile toggle), held until explicitly toggled off — user
 *    input must NOT release it (the mode exists to freeze the screen while
 *    the OS long-press selection runs; key-bar keys still send input).
 * Output is held while either owner is active.
 *
 * Snapshot restore (`beginSnapshotRestore`/`endSnapshotRestore`): a full
 * screen restore replaces everything — held chunks predate it and are
 * dropped, the restore itself writes through, and only the MODE hold re-arms
 * afterwards (a reconnect must not silently unfreeze select-mode, but a
 * gesture's stability is void after a reset anyway).
 */

/** Safety cap: a forgotten hold can't buffer unbounded output. When exceeded,
 *  buffered chunks are force-flushed but the hold itself stays armed. */
export const HOLD_MAX_BYTES = 1 * 1024 * 1024;

export interface TermWriteHold {
    /** Write `data` now, or buffer it while a hold is active. */
    gatedWrite(data: Uint8Array): void;
    /** Mouse gesture began on the terminal host. Only `button === 0` arms the
     *  hold — see the header comment for why non-primary buttons must not. */
    gestureStart(button: number): void;
    /** Gesture over (mouseup / window blur / contextmenu / lost-mouseup
     *  rescue). Flushes unless select-mode still holds. Idempotent. */
    gestureEnd(): void;
    /** User sent input to the pty: release a stuck gesture hold so the echo
     *  is never invisibly swallowed. No-op for the select-mode hold. */
    noteUserInput(): void;
    /** Mobile select-mode toggled. */
    setModeHold(on: boolean): void;
    /** Full screen restore incoming: drop stale held chunks, drop the gesture
     *  hold, write the restore through. */
    beginSnapshotRestore(): void;
    /** Restore done: re-arm buffering iff select-mode is (still) on. */
    endSnapshotRestore(): void;
    isHolding(): boolean;
    isGestureHolding(): boolean;
    heldByteCount(): number;
}

export function createTermWriteHold(
    write: (data: Uint8Array) => void,
    maxHeldBytes: number = HOLD_MAX_BYTES,
): TermWriteHold {
    let gestureActive = false;
    let modeActive = false;
    let restoring = false;
    let held: Uint8Array[] = [];
    let heldBytes = 0;

    const holding = () => !restoring && (gestureActive || modeActive);
    const flushAll = () => {
        const chunks = held;
        held = [];
        heldBytes = 0;
        for (const c of chunks) write(c);
    };
    /** Flush once no owner holds anymore. */
    const maybeRelease = () => {
        if (!holding()) flushAll();
    };

    return {
        gatedWrite(data) {
            if (holding()) {
                held.push(data);
                heldBytes += data.byteLength;
                // Cap: flush the backlog but keep holding (same trade-off as
                // before extraction — bounded memory beats a perfect freeze).
                if (heldBytes > maxHeldBytes) flushAll();
                return;
            }
            write(data);
        },
        gestureStart(button) {
            if (button !== 0) return;
            gestureActive = true;
        },
        gestureEnd() {
            if (!gestureActive) return;
            gestureActive = false;
            maybeRelease();
        },
        noteUserInput() {
            if (!gestureActive) return;
            gestureActive = false;
            maybeRelease();
        },
        setModeHold(on) {
            if (modeActive === on) return;
            modeActive = on;
            maybeRelease();
        },
        beginSnapshotRestore() {
            held = [];
            heldBytes = 0;
            gestureActive = false;
            restoring = true;
        },
        endSnapshotRestore() {
            restoring = false;
        },
        isHolding: holding,
        isGestureHolding: () => gestureActive,
        heldByteCount: () => heldBytes,
    };
}
