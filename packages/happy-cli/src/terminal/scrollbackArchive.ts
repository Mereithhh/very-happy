/**
 * B-550 terminal scrollback persistence — the PURE half (no fs, no tmux).
 *
 * B-149/B-150/B-265 bring terminals back after a daemon gap or a close, but as
 * a brand-new tmux session: the screen and the scrollback started empty. This
 * module holds every rule for carrying the old scrollback across:
 *
 *  - what a checkpoint body is (sanitised, CRLF, newest-first byte cap);
 *  - the on-disk file format (one header line + body), tolerant decode;
 *  - chaining an older archive with the last checkpoint when a terminal is
 *    rebuilt (`chainArchive`);
 *  - how the archive is replayed: ABOVE the current capture inside the `full`
 *    restore payload, between visible separators, with SGR resets at every seam
 *    we fabricate (B-288) — never into the pane's stdin;
 *  - which terminals to checkpoint on a tick, and which files to GC.
 *
 * Spec: specs/2026-10-terminal-scrollback-persistence.md.
 */
import { normalizeCaptureLines, truncateToBudget, type RestorePayload } from './captureAssembly';

/** Per-file cap — and the replay cap: we never store more than can be shown
 *  (Orca stores 5MB for log compaction; for us extra bytes would only be extra
 *  retention of possibly sensitive output). */
export const SCROLLBACK_FILE_MAX_BYTES = 512 * 1024;
/** Whole-directory cap; oldest files are evicted first. */
export const SCROLLBACK_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
/** Files older than this are deleted regardless of membership. */
export const SCROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Capture depth = tmux `history-limit` set on vh sessions = web scrollback. */
export const SCROLLBACK_CAPTURE_LINES = 5000;

/** Output has been quiet this long → a checkpoint is due. */
export const CHECKPOINT_QUIET_MS = 3_000;
/** …but never more often than this per terminal. */
export const CHECKPOINT_MIN_INTERVAL_MS = 30_000;
/** Never-quiet terminals (spinner, `tail -f`) are still checkpointed this often. */
export const CHECKPOINT_MAX_DIRTY_MS = 120_000;
/** Bound on captures per tick (each is one or two tmux subprocesses). */
export const CHECKPOINTS_PER_TICK = 4;

/** Default for `settings.terminalScrollbackPersist` when absent/malformed.
 *  Spec 风险 1: recommended ON; flip here to make it opt-in. */
export const SCROLLBACK_PERSIST_DEFAULT = true;

export interface ScrollbackConfig {
    enabled: boolean;
}

/** Tolerant read of the machine-local switch (settings.json). */
export function resolveScrollbackConfig(raw: { terminalScrollbackPersist?: unknown } | null | undefined): ScrollbackConfig {
    const v = raw?.terminalScrollbackPersist;
    return { enabled: typeof v === 'boolean' ? v : SCROLLBACK_PERSIST_DEFAULT };
}

const ESC = 0x1b;
const SGR_RESET = Buffer.from('\x1b[0m', 'ascii');
const CRLF = Buffer.from('\r\n', 'ascii');

/**
 * Keep only what a scrollback replay may contain: printable bytes (incl.
 * UTF-8), TAB/CR/LF and SGR (`CSI [0-9;:]* m`). Everything else is dropped
 * whole — cursor movement, mode switches (`?1049h`), clears, OSC (OSC 52 would
 * WRITE THE VIEWER'S CLIPBOARD, OSC 8 links), DCS/APC/PM/SOS strings, other C0
 * and the UTF-8-encoded C1 range U+0080–U+009F (xterm.js executes C1).
 *
 * `capture-pane -e` normally emits nothing but SGR; this is the defence for a
 * file on disk that may be truncated or tampered with. An unterminated escape
 * sequence swallows only itself up to the next line end, never the rest.
 */
export function sanitizeArchivedScrollback(input: Buffer): Buffer {
    const out = Buffer.allocUnsafe(input.length);
    let o = 0;
    const n = input.length;
    let i = 0;
    while (i < n) {
        const b = input[i];
        if (b === ESC) {
            const next = i + 1 < n ? input[i + 1] : -1;
            if (next === 0x5b /* [ */) {
                // CSI: params 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E.
                let j = i + 2;
                let paramsOk = true;
                while (j < n && input[j] >= 0x30 && input[j] <= 0x3f) {
                    const c = input[j];
                    if (!((c >= 0x30 && c <= 0x39) || c === 0x3b || c === 0x3a)) paramsOk = false;
                    j++;
                }
                let intermediates = false;
                while (j < n && input[j] >= 0x20 && input[j] <= 0x2f) { intermediates = true; j++; }
                if (j < n && input[j] >= 0x40 && input[j] <= 0x7e) {
                    if (input[j] === 0x6d /* m */ && paramsOk && !intermediates) {
                        input.copy(out, o, i, j + 1);
                        o += j + 1 - i;
                    }
                    i = j + 1;
                } else {
                    i = skipToLineEnd(input, j); // torn CSI: drop it only
                }
                continue;
            }
            if (next === 0x5d /* ] */ || next === 0x50 /* P */ || next === 0x5f /* _ */ || next === 0x5e /* ^ */ || next === 0x58 /* X */) {
                // String sequences: skip to BEL (OSC only) or ST (ESC \), never past a line end.
                let j = i + 2;
                while (j < n) {
                    if (input[j] === 0x07 && next === 0x5d) { j += 1; break; }
                    if (input[j] === ESC && j + 1 < n && input[j + 1] === 0x5c) { j += 2; break; }
                    if (input[j] === 0x0a) break;
                    j++;
                }
                i = j;
                continue;
            }
            // Any other ESC x (incl. a trailing lone ESC): drop both bytes.
            i += next === -1 ? 1 : 2;
            continue;
        }
        if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) { i++; continue; }
        if (b === 0x7f) { i++; continue; }
        // UTF-8 encoded C1 (U+0080–U+009F) = C2 80..C2 9F.
        if (b === 0xc2 && i + 1 < n && input[i + 1] >= 0x80 && input[i + 1] <= 0x9f) { i += 2; continue; }
        out[o++] = b;
        i++;
    }
    return out.subarray(0, o);
}

function skipToLineEnd(buf: Buffer, from: number): number {
    const nl = buf.indexOf(0x0a, from);
    return nl === -1 ? buf.length : nl;
}

function splitCrlfLines(blob: Buffer): Buffer[] {
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

/** A row that renders as nothing: empty, or only SGR / spaces. */
function isBlankRow(row: Buffer): boolean {
    return /^(?:\x1b\[[0-9;:]*m| )*$/.test(row.toString('latin1'));
}

function joinCrlf(lines: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    lines.forEach((l, i) => {
        if (i > 0) parts.push(CRLF);
        parts.push(l);
    });
    return Buffer.concat(parts);
}

/**
 * Build a checkpoint body from one or more `capture-pane -p` outputs (in
 * screen order). Each part is sanitised, rebuilt with CRLF seams and stripped
 * of trailing blank rows (the bottom of a mostly-empty screen); parts are
 * joined at a reset seam (each capture starts its own default pen, B-288), and
 * the result is cut to the newest `budget` bytes on a line boundary.
 */
export function buildCheckpointBody(parts: Buffer[], budget = SCROLLBACK_FILE_MAX_BYTES): Buffer {
    const cleaned: Buffer[] = [];
    for (const part of parts) {
        const lines = splitCrlfLines(normalizeCaptureLines(sanitizeArchivedScrollback(part)));
        while (lines.length > 0 && isBlankRow(lines[lines.length - 1])) lines.pop();
        if (lines.length > 0) cleaned.push(joinCrlf(lines));
    }
    const joined: Buffer[] = [];
    cleaned.forEach((c, i) => {
        if (i > 0) joined.push(SGR_RESET, CRLF);
        joined.push(c);
    });
    return truncateToBudget(Buffer.concat(joined), budget);
}

export interface ArchiveFile {
    savedAt: number;
    body: Buffer;
}

const FILE_MAGIC = 'VHSB1';

export function encodeArchiveFile(file: ArchiveFile): Buffer {
    return Buffer.concat([Buffer.from(`${FILE_MAGIC} ${Math.floor(file.savedAt)}\n`, 'ascii'), file.body]);
}

/** Tolerant decode: anything malformed is `null` (treated as "no archive").
 *  The body is re-sanitised and re-capped — the file is untrusted input. */
export function decodeArchiveFile(raw: Buffer | null | undefined): ArchiveFile | null {
    if (!raw || raw.length === 0) return null;
    const nl = raw.indexOf(0x0a);
    if (nl <= 0 || nl > 64) return null;
    const m = /^VHSB1 (\d{1,16})$/.exec(raw.subarray(0, nl).toString('ascii'));
    if (!m) return null;
    const savedAt = Number(m[1]);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
    const body = truncateToBudget(sanitizeArchivedScrollback(raw.subarray(nl + 1)), SCROLLBACK_FILE_MAX_BYTES);
    if (body.length === 0) return null;
    return { savedAt, body };
}

const DIM = '\x1b[0;2m';
const RESET = '\x1b[0m';

/** Inner seam between two earlier lives inside one chained archive. */
const REBUILD_SEPARATOR = Buffer.from(`${DIM}── 重建 · rebuilt ──${RESET}`, 'utf8');

/**
 * Promotion (spec D3): the archive replayed above a REBUILT terminal is every
 * earlier life it had — the previous archive, an inner separator, then the last
 * checkpoint of the life that just ended — capped to the newest bytes.
 */
export function chainArchive(prev: ArchiveFile | null, live: ArchiveFile | null, budget = SCROLLBACK_FILE_MAX_BYTES): ArchiveFile | null {
    if (!prev) return live ? { savedAt: live.savedAt, body: truncateToBudget(live.body, budget) } : null;
    if (!live) return { savedAt: prev.savedAt, body: truncateToBudget(prev.body, budget) };
    const body = Buffer.concat([prev.body, SGR_RESET, CRLF, REBUILD_SEPARATOR, CRLF, live.body]);
    return { savedAt: Math.max(prev.savedAt, live.savedAt), body: truncateToBudget(body, budget) };
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** `MM-DD HH:mm` in the daemon's local time. */
export function formatSavedAt(savedAt: number): string {
    const d = new Date(savedAt);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function archiveHeaderLine(savedAt: number): Buffer {
    return Buffer.from(`${DIM}── 以下为上次会话的输出 · previous session (${formatSavedAt(savedAt)}) ──${RESET}`, 'utf8');
}

export const ARCHIVE_FOOTER_LINE = Buffer.from(`${DIM}── 以上为上次会话的输出 · 终端已重建，进程是新的 ──${RESET}`, 'utf8');

/**
 * Replay (spec D4): put the archive ABOVE the current capture in the deep
 * `full` payload only. Every seam here is ours, so every seam gets a reset; the
 * archive's own rows are untouched (a colour spanning rows must survive). The
 * screen part of `full` keeps its "exactly `rows` rows + absolute CUP" shape at
 * the very end, so the cursor still lands where the application believes it is.
 * `small` (the instant inline snapshot) is deliberately not touched.
 */
export function withArchivedScrollback(payload: RestorePayload, archive: ArchiveFile | null): RestorePayload {
    if (!archive || archive.body.length === 0) return payload;
    const full = Buffer.concat([
        SGR_RESET, archiveHeaderLine(archive.savedAt), CRLF,
        archive.body, SGR_RESET, CRLF,
        ARCHIVE_FOOTER_LINE, CRLF,
        payload.full,
    ]);
    return { ...payload, full };
}

// ── Tick planning ──────────────────────────────────────────────────────────

/** `list-sessions -F` format of the per-tick probe. `|` only (iron rule 19);
 *  `vh-<id>` names cannot contain it. `window_activity` (not
 *  `session_activity`, which does not move on pane output). */
export const CHECKPOINT_PROBE_FORMAT = '#{session_name}|#{window_activity}|#{alternate_on}|#{@vh_attach}';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ProbedTerminal {
    id: string;
    /** Last pane output (window_activity), epoch ms. */
    activityAt: number;
    alternateOn: boolean;
}

/** Parse the probe. Skips non-vh sessions, attach terminals (B-273: the outer
 *  pane only shows an inner tmux client) and malformed lines. */
export function parseCheckpointProbe(stdout: string): ProbedTerminal[] {
    const out: ProbedTerminal[] = [];
    for (const line of stdout.split('\n')) {
        const parts = line.split('|');
        if (parts.length < 4) continue;
        const [name, activity, alt] = parts;
        const attach = parts.slice(3).join('|');
        if (!name.startsWith('vh-')) continue;
        const id = name.slice(3);
        if (!ID_RE.test(id)) continue;
        if (attach.trim().length > 0) continue;
        const secs = Number(activity);
        if (!Number.isFinite(secs) || secs <= 0) continue;
        out.push({ id, activityAt: secs * 1000, alternateOn: alt === '1' });
    }
    return out;
}

export interface CheckpointState {
    /** When the last checkpoint's capture STARTED (output before it is in it). */
    at: number;
}

/** `window_activity` has one-second resolution: output stamped second S
 *  happened somewhere in [S, S+1s). */
export const ACTIVITY_RESOLUTION_MS = 1000;

export interface CheckpointPlanOptions {
    quietMs?: number;
    minIntervalMs?: number;
    maxDirtyMs?: number;
    max?: number;
}

/**
 * Which terminals to capture now. Dirty = output newer than the last
 * checkpoint; due when quiet long enough (and not too soon after the previous
 * one), or when dirty for too long regardless. Oldest checkpoint first, capped.
 */
export function planCheckpoints(
    terminals: readonly ProbedTerminal[],
    state: ReadonlyMap<string, CheckpointState>,
    now: number,
    opts: CheckpointPlanOptions = {},
): string[] {
    const quietMs = opts.quietMs ?? CHECKPOINT_QUIET_MS;
    const minIntervalMs = opts.minIntervalMs ?? CHECKPOINT_MIN_INTERVAL_MS;
    const maxDirtyMs = opts.maxDirtyMs ?? CHECKPOINT_MAX_DIRTY_MS;
    const max = opts.max ?? CHECKPOINTS_PER_TICK;
    const due: Array<{ id: string; lastAt: number }> = [];
    for (const t of terminals) {
        const prev = state.get(t.id);
        // Clean only when the whole activity second ended before the capture
        // started — output later in the same second may not be in it.
        if (prev && t.activityAt + ACTIVITY_RESOLUTION_MS <= prev.at) continue;
        const lastAt = prev?.at ?? 0;
        const quiet = now - t.activityAt >= quietMs && now - lastAt >= minIntervalMs;
        const overdue = now - lastAt >= maxDirtyMs;
        if (quiet || overdue) due.push({ id: t.id, lastAt });
    }
    due.sort((a, b) => a.lastAt - b.lastAt || (a.id < b.id ? -1 : 1));
    return due.slice(0, Math.max(0, max)).map((d) => d.id);
}

/** `capture-pane` argv lists (without the tmux socket prefix) for one
 *  checkpoint, in screen order. Alt screen: history + the saved normal screen,
 *  never the alt frame itself (vim/less is not scrollback). */
export function checkpointCaptureArgs(id: string, alternateOn: boolean, lines = SCROLLBACK_CAPTURE_LINES): string[][] {
    const t = `=vh-${id}:`;
    const n = Math.max(1, Math.floor(lines));
    if (!alternateOn) return [['capture-pane', '-peqJN', '-t', t, '-S', `-${n}`]];
    return [
        ['capture-pane', '-peqJN', '-t', t, '-S', `-${n}`, '-E', '-1'],
        ['capture-pane', '-peqJN', '-t', t, '-a'],
    ];
}

// ── GC ─────────────────────────────────────────────────────────────────────

export type ArchiveKind = 'live' | 'prev';

export interface ArchiveFileEntry {
    name: string;
    /** null = not one of our file names (deleted as garbage). */
    id: string | null;
    kind: ArchiveKind | null;
    mtimeMs: number;
    bytes: number;
}

const FILE_RE = /^([a-zA-Z0-9_-]{1,64})\.(live|prev)\.vhsb$/;

export function archiveFileName(id: string, kind: ArchiveKind): string {
    if (!ID_RE.test(id)) throw new Error(`invalid terminal id: ${id}`);
    return `${id}.${kind}.vhsb`;
}

export function parseArchiveFileName(name: string): { id: string; kind: ArchiveKind } | null {
    const m = FILE_RE.exec(name);
    return m ? { id: m[1], kind: m[2] as ArchiveKind } : null;
}

/**
 * Files to delete: foreign names, TTL-expired, ids that are neither live nor in
 * the closed records (`keepIds === null` = membership unknown this round → skip
 * that rule rather than delete live terminals' files), then oldest-first until
 * under the total cap.
 */
export function planScrollbackGc(
    files: readonly ArchiveFileEntry[],
    keepIds: ReadonlySet<string> | null,
    now: number,
    ttlMs = SCROLLBACK_TTL_MS,
    totalMax = SCROLLBACK_TOTAL_MAX_BYTES,
): string[] {
    const doomed = new Set<string>();
    for (const f of files) {
        if (!f.id || !f.kind) { doomed.add(f.name); continue; }
        if (now - f.mtimeMs > ttlMs) { doomed.add(f.name); continue; }
        if (keepIds && !keepIds.has(f.id)) doomed.add(f.name);
    }
    const survivors = files.filter((f) => !doomed.has(f.name)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = survivors.reduce((s, f) => s + f.bytes, 0);
    for (const f of survivors) {
        if (total <= totalMax) break;
        doomed.add(f.name);
        total -= f.bytes;
    }
    return [...doomed];
}

