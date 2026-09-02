/**
 * B-121 terminal channel v2 — capture batch construction + screen reassembly.
 *
 * In the lines-mode channel the daemon no longer owns a tmux-painted mirror: a
 * (re)opening client is brought up to date from `capture-pane` output instead.
 * This module is the PURE half of that — it builds the command batch and turns
 * the responses back into a byte stream a terminal emulator can replay. No
 * subprocesses, no tmux, no I/O, so every rule below is unit-testable.
 *
 * ── Why the batch is one atomic write ────────────────────────────────────────
 * The commands travel down the control client's stdin as ONE write, so tmux
 * runs them back to back with no `%output` wedged between the response blocks
 * (verified empirically — a second write can interleave). That gives a single
 * point in time for the whole restore, and the LAST command of the batch
 * (`refresh-client -C`) doubles as the anchor: every `%output` after its `%end`
 * is, by construction, not included in any capture in the batch.
 *
 * ── Why both screen shapes are always captured ("双份全发") ──────────────────
 * Which assembly is correct depends on `alternate_on`, which is only knowable
 * from the batch's own `list-panes` response — and reading it first would need
 * a second round trip, breaking the "one point in time" property above. So the
 * batch sends the commands for BOTH shapes and the daemon picks after the fact,
 * discarding the unused half.
 *
 * ── The two shapes (verified on tmux 3.6b AND 3.7b, 2026-08-17) ──────────────
 *  - normal screen active: `capture-pane -peqJN -S -<N>` returns history AND
 *    the current screen in one blob.
 *  - alternate screen active (vim / less / a fullscreen TUI): the same command
 *    returns history + the ALT screen's content, which must never be written
 *    into the browser's scrollback (that is the whole point of the feature).
 *    The three-part assembly instead tiles exactly:
 *      `-S -<N> -E -1` (history only, ends at the last line before the screen)
 *      + `-a`          (the SAVED normal screen — the lines the alt screen hid)
 *      + `\x1b[?1049h` (switch the emulator into ITS alt buffer)
 *      + no-flag capture (the visible alt content).
 *    Probe: with `seq 1 200 | less` running, history-only ended at hist-line-22
 *    and `-a` began at hist-line-23 — no gap, no overlap.
 *
 * ── Line endings ─────────────────────────────────────────────────────────────
 * capture-pane separates lines with a bare `\n`. Replaying that into an
 * emulator staircases the text (LF moves down, never back to column 0), so
 * every seam here is rebuilt with CRLF. `-J` means a wrapped logical line
 * arrives as ONE long line and is re-wrapped by the receiving terminal at its
 * own width — which is exactly why a phone and a desktop can restore the same
 * capture and both look right.
 */

/** Which capture in the batch a response belongs to. */
export type CaptureKey =
    /** Scrollback only (`-E -1`), as LOGICAL lines (`-J`) so the client can
     *  re-wrap it at its own width. */
    | 'history'
    /** The same, shallow — the "秒开" snapshot's scrollback. */
    | 'smallHistory'
    /** the saved normal screen (`-a`) — the lines the alt screen hid. */
    | 'altSaved'
    /**
     * The visible screen as PHYSICAL ROWS (no `-J`): exactly one row per screen
     * line. The screen is the part the application addresses with cursor moves,
     * so it must be reproduced row for row — joining wrapped lines here would
     * make the restored screen a different height than the pane and every
     * relative cursor move afterwards would land on the wrong row.
     */
    | 'visible'
    /** `list-panes -F` state line (alternate_on, cursor, geometry). */
    | 'panes'
    /** `-p -P -C`: bytes of an escape sequence the pane has not finished. */
    | 'tail'
    /** `refresh-client -C` — the batch ANCHOR (see the header). */
    | 'anchor';

export interface CaptureBatchOptions {
    /** tmux target for the pane (`%12`, or `=vh-<id>:`). Caller-validated. */
    paneTarget: string;
    /** How much history to capture for the full snapshot (tmux history-limit). */
    historyLines: number;
    /** Depth of the small "秒开" snapshot (300-line class — see SPEC D1). */
    smallLines: number;
    cols: number;
    rows: number;
}

export interface CaptureCommand {
    key: CaptureKey;
    /** One control-mode command line (no trailing newline). */
    command: string;
}

/** `list-panes -F` fields, in order, that the batch asks for. `pane_id` leads:
 *  the session LATCHES it and afterwards ignores `%output` from every other
 *  pane (spec D1 single-pane declaration — a user who splits the window locally
 *  keeps his split, the web just doesn't mirror it). */
export const PANE_STATE_FORMAT = '#{pane_id}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}';

export interface PaneState {
    /** e.g. `%7` — matches `ControlModeOutputEvent.pane`. */
    paneId: string;
    alternateOn: boolean;
    cursorX: number;
    cursorY: number;
    width: number;
    height: number;
}

/**
 * Parse the `panes` response. Returns undefined for anything unparseable (the
 * caller then treats the terminal as normal-screen, the conservative default:
 * a normal assembly of an alt pane is ugly, an alt assembly of a normal pane
 * would leave the emulator stuck in its alt buffer with no scrollback).
 */
export function parsePaneState(response: string): PaneState | undefined {
    // list-panes prints one line per pane, ordered by index — the FIRST line is
    // the pane this terminal follows.
    const line = response.split('\n').find((l) => l.trim().length > 0);
    if (!line) return undefined;
    const parts = line.trim().split('|');
    if (parts.length < 6) return undefined;
    const [paneId, alt, cx, cy, w, h] = parts.map((p) => p.trim());
    if (!paneId.startsWith('%')) return undefined;
    if (alt !== '0' && alt !== '1') return undefined;
    const nums = [cx, cy, w, h].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return undefined;
    return { paneId, alternateOn: alt === '1', cursorX: nums[0], cursorY: nums[1], width: nums[2], height: nums[3] };
}

/**
 * The batch, in the order it is written to the control client's stdin. The
 * anchor is LAST by construction — callers rely on that (see header), and the
 * order of the captures among themselves does not matter because tmux runs the
 * whole batch without letting pane output in between.
 */
export function buildCaptureBatch(o: CaptureBatchOptions): CaptureCommand[] {
    const t = o.paneTarget;
    const n = Math.max(1, Math.floor(o.historyLines));
    const small = Math.max(1, Math.floor(o.smallLines));
    const cols = Math.max(2, Math.floor(o.cols));
    const rows = Math.max(2, Math.floor(o.rows));
    return [
        { key: 'history', command: `capture-pane -peqJN -t ${t} -S -${n} -E -1` },
        { key: 'smallHistory', command: `capture-pane -peqJN -t ${t} -S -${small} -E -1` },
        { key: 'altSaved', command: `capture-pane -peqJN -t ${t} -a` },
        // No `-J`: physical rows (see CaptureKey.visible).
        { key: 'visible', command: `capture-pane -peqN -t ${t}` },
        { key: 'panes', command: `list-panes -t ${t} -F "${PANE_STATE_FORMAT}"` },
        { key: 'tail', command: `capture-pane -p -P -C -t ${t}` },
        // ANCHOR. Also makes tmux repaint the pane, which is what puts the
        // cursor back where the application thinks it is after a restore.
        { key: 'anchor', command: `refresh-client -C ${cols}x${rows}` },
    ];
}

/** Byte budget for the FULL snapshot blob (spec D1: total history bounded). */
export const CAPTURE_FULL_BUDGET_BYTES = 1024 * 1024;

/** ESC [ ? 1049 h — switch the receiving emulator into its alternate buffer. */
const ALT_ENTER = Buffer.from('\x1b[?1049h', 'ascii');
/** Cursor home. After 1049h the emulator keeps the previous cursor position,
 *  so the captured alt screen would be written from wherever the normal screen
 *  had left it. */
const CURSOR_HOME = Buffer.from('\x1b[H', 'ascii');
const CRLF = Buffer.from('\r\n', 'ascii');
/**
 * SGR reset (B-288). `capture-pane -e` reproduces a green tmux copy-mode
 * selection / status bar as an OPEN background run and — measured on tmux 3.7b
 * — does NOT re-declare the attribute at a wrapped/continued row start; the pen
 * carries across rows. So we must reset ONLY at the seams THIS module
 * fabricates between separately-captured sections (each `capture-pane` starts
 * its own pen at default, so the next section re-declares any non-default from
 * its first cell → a section-boundary reset is lossless). Never reset between
 * a capture's own rows, or a spanning colour would be stripped from row 2+.
 */
const SGR_RESET = Buffer.from('\x1b[0m', 'ascii');

/**
 * Rebuild one capture blob as replayable bytes: LF (and any stray CRLF) seams
 * become CRLF, and the trailing newline capture always appends is dropped (it
 * would push the restored screen down one line). Pure byte work — capture
 * output is not guaranteed to be valid UTF-8 (a pane can print anything), so
 * it never goes through a string decode.
 */
export function normalizeCaptureLines(blob: Buffer): Buffer {
    if (blob.length === 0) return blob;
    const lines: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < blob.length; i++) {
        if (blob[i] !== 0x0a) continue;
        let end = i;
        if (end > start && blob[end - 1] === 0x0d) end -= 1; // pre-existing CRLF
        lines.push(blob.subarray(start, end));
        start = i + 1;
    }
    if (start < blob.length) lines.push(blob.subarray(start)); // no trailing LF
    const out: Buffer[] = [];
    lines.forEach((l, i) => {
        if (i > 0) out.push(CRLF);
        out.push(l);
    });
    return Buffer.concat(out);
}

/**
 * Enforce the byte budget by dropping the OLDEST lines. Truncation must land on
 * a line boundary: cutting mid-line can split a multi-byte character or, worse,
 * an SGR sequence, and a torn escape sequence corrupts everything that follows
 * (same rule as the decoder's "never truncate a chunk"). The colour drift a
 * line-boundary cut can cause (a run that started above the cut) lasts only
 * until the next SGR code and is covered by the spec's "readable, not
 * pixel-identical" promise for history.
 */
export function truncateToBudget(blob: Buffer, budget = CAPTURE_FULL_BUDGET_BYTES): Buffer {
    if (blob.length <= budget) return blob;
    // Keep the NEWEST budget bytes, then advance to the next line start.
    let cut = blob.length - budget;
    const nl = blob.indexOf(0x0a, cut);
    if (nl === -1) return blob.subarray(blob.length - budget); // one huge line: keep the tail
    cut = nl + 1;
    if (cut < blob.length && blob[cut] === 0x0d) cut += 1;
    return blob.subarray(cut);
}

export interface RestorePayload {
    /** The deep restore (history + screen), byte-budgeted. */
    full: Buffer;
    /** The shallow restore shipped inline with the open response. */
    small: Buffer;
    /** Was the pane on its alternate screen at capture time? Travels to the web
     *  so it can pick the right scroll lane before the deep rebuild lands. */
    alternateOn: boolean;
}

/**
 * Assemble the restore payloads from the batch responses.
 *
 * `tail` must already be octal-UNESCAPED by the caller (the `-C` flag escapes
 * non-printables; the control-mode decoder owns that primitive and this module
 * must not grow a second copy of it). Missing responses are treated as empty —
 * a partial batch degrades the restore, it never throws.
 */
export function assembleRestore(
    responses: Partial<Record<CaptureKey, Buffer>>,
    paneState: PaneState | undefined,
    budget = CAPTURE_FULL_BUDGET_BYTES,
): RestorePayload {
    const get = (k: CaptureKey) => responses[k] ?? Buffer.alloc(0);
    // `-p -P -C` returns the pane's UNFINISHED escape sequence — but it prints
    // it as a LINE, so it comes back with a trailing newline even when there is
    // nothing pending (measured: 1 byte, just the LF). Replaying that newline
    // scrolls the restored screen up by one row: the top row falls off the
    // viewport, a blank shows up at the bottom, and the absolutely-positioned
    // cursor lands one row below the text it belongs to — the input box drawn
    // over its own border (B-126). A pending escape sequence never ends with a
    // newline, so stripping it is free.
    const tail = stripTrailingNewlines(get('tail'));
    const alternateOn = paneState?.alternateOn === true;
    const rows = paneState?.height;

    // The screen, rebuilt row for row and made exactly `rows` tall, followed by
    // an explicit cursor position.
    //
    // ⚠️ The cursor is NOT optional decoration — it is what every later repaint
    // is relative to. The spec originally left it to "the batch's closing
    // `refresh-client -C` triggers a repaint that heals it", which is only true
    // when that call CHANGES the size: measured on tmux 3.7b, a refresh to the
    // SAME size produces zero %output. Once the client and the pane agreed on
    // geometry (B-124), "same size" became the normal case, so nothing ever
    // healed the cursor: ink's erase-and-redraw then landed rows away from
    // where it meant to, stacking three different strings onto one line and
    // drawing the input box over its own border (Owner's screenshot, B-126).
    const screen = (): Buffer => {
        const raw = get('visible');
        const lines = splitLines(raw);
        let realCount = lines.length;
        if (rows !== undefined && rows > 0) {
            while (lines.length > rows) lines.shift();      // keep the LAST rows
            realCount = lines.length;
            while (lines.length < rows) lines.push(EMPTY);  // pad to a full screen
        }
        // Real screen rows are joined with bare CRLF so a colour that spans
        // rows (tmux does not re-declare it per row) stays intact. B-288: the
        // SYNTHESISED padding rows below the real content are a seam we made up,
        // so reset once before them — otherwise an unclosed background from the
        // last real row (e.g. a full-width green status/selection line) bleeds
        // down through the blank padding to the bottom of the screen.
        const realBody = joinCrlf(lines.slice(0, realCount));
        const padCount = lines.length - realCount;
        const padBody = padCount > 0
            ? Buffer.concat([realCount > 0 ? CRLF : EMPTY, SGR_RESET, joinCrlf(new Array(padCount).fill(EMPTY))])
            : EMPTY;
        const cursor = paneState
            ? Buffer.from(`\x1b[${paneState.cursorY + 1};${paneState.cursorX + 1}H`, 'ascii')
            : Buffer.alloc(0);
        // Reset before tail/cursor too: the last real row's open background must
        // not dye the cursor cell or the pending-escape tail.
        return Buffer.concat([realBody, padBody, SGR_RESET, tail, cursor]);
    };

    // B-288: bracket every payload in SGR resets so an unclosed captured
    // background cannot dye what comes next.
    //  - `full` gets a LEADING reset: the daemon headless restore
    //    (restoreHeadless) does NOT `term.reset()` first, so it needs a clean
    //    starting pen. It is also what an old web's serialize() snapshot reads.
    //  - both get a TRAILING reset: the app's live output AFTER the restore must
    //    start from default, not inherit the last captured cell's colour.
    //  - `small` gets NO leading reset: the web always `term.reset()`s before
    //    writing it, and it must still START with `\x1b[?1049h` on the alt path
    //    so the client enters the alt buffer.
    const wrapFull = (b: Buffer) => Buffer.concat([SGR_RESET, b, SGR_RESET]);
    const wrapSmall = (b: Buffer) => Buffer.concat([b, SGR_RESET]);

    if (!alternateOn) {
        const history = trimTrailingBlankRows(normalizeCaptureLines(get('history')));
        const smallHistory = trimTrailingBlankRows(normalizeCaptureLines(get('smallHistory')));
        // Reset at the history↔screen seam: history's last row may end with an
        // open background and the screen's first row, if it is default, emits no
        // SGR and would inherit it.
        const withHistory = (h: Buffer) => Buffer.concat(
            h.length > 0 ? [truncateToBudget(h, budget), SGR_RESET, CRLF, screen()] : [screen()],
        );
        return { full: wrapFull(withHistory(history)), small: wrapSmall(withHistory(smallHistory)), alternateOn };
    }

    // Alt: scrollback = history + the normal screen the alt buffer hid; then
    // switch the emulator to ITS alt buffer and paint the frame there, so the
    // fullscreen app never pollutes the scrollback we just rebuilt.
    const history = trimTrailingBlankRows(normalizeCaptureLines(get('history')));
    const saved = trimTrailingBlankRows(normalizeCaptureLines(get('altSaved')));
    const scrollback = truncateToBudget(
        Buffer.concat(history.length > 0 && saved.length > 0 ? [history, SGR_RESET, CRLF, saved] : [history, saved]),
        budget,
    );
    // Reset before painting the alt buffer: the pen carries across the 1049h
    // switch, so a scrollback line that ended green would tint the alt frame.
    const altScreen = Buffer.concat([ALT_ENTER, CURSOR_HOME, SGR_RESET, screen()]);
    return {
        full: wrapFull(Buffer.concat([scrollback, scrollback.length > 0 ? CRLF : Buffer.alloc(0), altScreen])),
        small: wrapSmall(altScreen),
        alternateOn,
    };
}

const EMPTY = Buffer.alloc(0);

function stripTrailingNewlines(blob: Buffer): Buffer {
    let end = blob.length;
    while (end > 0 && (blob[end - 1] === 0x0a || blob[end - 1] === 0x0d)) end -= 1;
    return blob.subarray(0, end);
}

/**
 * Drop blank rows at the END of a scrollback blob.
 *
 * Why this is not cosmetic: the screen is written straight after the history,
 * and every extra newline between them scrolls the screen up by one row. A
 * single trailing blank history line therefore pushes the whole restored screen
 * up one row — the top row falls off, a blank appears at the bottom, and the
 * cursor (positioned absolutely, from list-panes) ends up one row below the
 * text it belongs to. That is exactly what the input box drawn over its own
 * border looked like (B-126). Trailing blank scrollback carries no information,
 * so trimming it is free.
 */
function trimTrailingBlankRows(blob: Buffer): Buffer {
    const lines = splitLines(blob);
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
    return joinCrlf(lines);
}

/** Split on LF, dropping a single trailing empty element and any CR before LF. */
function splitLines(blob: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < blob.length; i++) {
        if (blob[i] !== 0x0a) continue;
        let end = i;
        if (end > start && blob[end - 1] === 0x0d) end -= 1;
        out.push(blob.subarray(start, end));
        start = i + 1;
    }
    if (start < blob.length) out.push(blob.subarray(start));
    return out;
}

function joinCrlf(lines: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    lines.forEach((l, i) => {
        if (i > 0) parts.push(CRLF);
        parts.push(l);
    });
    return Buffer.concat(parts);
}

