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
    /** history + current screen — the whole restore when normal is active. */
    | 'normalFull'
    /** history only (`-E -1`) — first third of the alt assembly. */
    | 'altHistory'
    /** the saved normal screen (`-a`) — second third of the alt assembly. */
    | 'altSaved'
    /** the pane's visible content with no range flags: the alt screen when alt
     *  is active, the current screen otherwise. */
    | 'visible'
    /** shallow (SNAPSHOT-sized) capture for the fast first paint, normal case. */
    | 'normalSmall'
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
        { key: 'normalFull', command: `capture-pane -peqJN -t ${t} -S -${n}` },
        { key: 'altHistory', command: `capture-pane -peqJN -t ${t} -S -${n} -E -1` },
        { key: 'altSaved', command: `capture-pane -peqJN -t ${t} -a` },
        { key: 'visible', command: `capture-pane -peqJN -t ${t}` },
        { key: 'normalSmall', command: `capture-pane -peqJN -t ${t} -S -${small}` },
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
    const tail = get('tail');
    const alternateOn = paneState?.alternateOn === true;

    if (!alternateOn) {
        const full = Buffer.concat([truncateToBudget(normalizeCaptureLines(get('normalFull')), budget), tail]);
        const small = Buffer.concat([normalizeCaptureLines(get('normalSmall')), tail]);
        return { full, small, alternateOn };
    }

    // Alt: history + the screen the alt buffer hid, then switch the receiving
    // emulator to ITS alt buffer and paint the visible content there — so the
    // fullscreen app's frame never pollutes the scrollback we just rebuilt.
    const history = normalizeCaptureLines(get('altHistory'));
    const saved = normalizeCaptureLines(get('altSaved'));
    const visible = normalizeCaptureLines(get('visible'));
    const scrollback = truncateToBudget(
        Buffer.concat(history.length > 0 && saved.length > 0 ? [history, CRLF, saved] : [history, saved]),
        budget,
    );
    const altScreen = Buffer.concat([ALT_ENTER, CURSOR_HOME, visible, tail]);
    return {
        full: Buffer.concat([scrollback, scrollback.length > 0 ? CRLF : Buffer.alloc(0), altScreen]),
        small: altScreen,
        alternateOn,
    };
}
