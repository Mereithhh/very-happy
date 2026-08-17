/**
 * ControlModeDecoder — byte-exact incremental decoder for tmux control mode
 * (`tmux -C attach-session`) stdout. Phase 0a of B-121 (terminal channel v2,
 * `specs/2026-08-terminal-channel-v2.md` D1).
 *
 * ## Why bytes, never strings
 *
 * tmux escapes a `%output` payload with exactly this rule (3.6a/3.7b
 * `control.c:control_append_data`):
 *
 *     if (byte < 0x20 || byte == '\\')  ->  "\%03o"   else  byte verbatim
 *
 * So every byte >= 0x80 passes through RAW and a payload is NOT guaranteed to
 * be valid UTF-8 (`cat /dev/urandom`, a half-written multi-byte sequence at a
 * pane-read boundary, latin1 program output...). Decoding to a JS string
 * anywhere on this path replaces the offending bytes with U+FFFD and the loss
 * is permanent. Everything here therefore works on `Buffer`s: line splitting,
 * octal unescaping, block bodies. Consumers get `Buffer`s and are expected to
 * base64 them straight into the existing ring/wire.
 *
 * ## Protocol shape (measured on this machine, 2026-08-17, isolated socket)
 *
 *     %begin <epoch> <cmdNum> <flags>     command output block opens
 *     ...raw bytes, ESC *not* escaped...  (block bodies are unescaped!)
 *     %end   <epoch> <cmdNum> <flags>     ...closes ok
 *     %error <epoch> <cmdNum> <flags>     ...or closes with an error
 *     %output %<pane> <octal-escaped>     pane output
 *     %extended-output %<pane> <age> : <octal-escaped>   (pause-after mode)
 *     %<name> <args...>                   every other notification
 *
 * Lines are terminated by a bare LF (`\n`), NOT CRLF — the control client is
 * spawned on a pipe, and tmux reads/writes control lines with
 * `EVBUFFER_EOL_LF`. A `\r` inside a `%output` payload arrives escaped as
 * `\015`, so an LF split is unambiguous — which also means a RAW trailing `\r`
 * on a control line or a `%output` payload can only be half of a CRLF
 * terminator, and is dropped. Block BODY bytes are byte-verbatim and never
 * touched (a pty-hosted stream would embed the CR there; out of scope, the
 * daemon spawns the control client on a pipe).
 *
 * ## `flags` = "this block answers a command *I* sent"
 *
 * `cmd-queue.c:cmdq_fire_command` emits the guard as
 * `flags = !!(state->flags & CMDQ_STATE_CONTROL)`, and `CMDQ_STATE_CONTROL` is
 * set in exactly one place: `control.c:control_read_callback`, i.e. when the
 * command was parsed off THIS control client's stdin (identical in 3.6a and
 * master). Therefore `flags & 1`:
 *
 *   - 1 -> a response to a command this client wrote. FIFO-pair it.
 *   - 0 -> UNSOLICITED. The attach-time greeting (empty block) is one such
 *          block, but it is **not the only one**: a tmux hook firing a command
 *          (e.g. `set-hook -g after-set-option 'display-message ...'`) also
 *          produces a flags=0 block, mid-stream, at an arbitrary moment
 *          (measured). Pairing "next block == next pending command" without
 *          filtering on `solicited` therefore corrupts the command queue on any
 *          machine whose tmux.conf has hooks. Never do it.
 *
 * Blocks are still paired by exact (epoch, cmdNum) match between `%begin` and
 * its `%end`/`%error`: a body line that happens to read `%end 1 2 3` is body
 * bytes, not a terminator, unless the numbers match the open block.
 *
 * ## Split safety
 *
 * `push()` accepts any byte-boundary chunking: the escape carry (`\`, `\0`,
 * `\01`), the line prefix, and block bodies all survive being cut anywhere.
 * Feeding the same stream in one chunk or 1-byte chunks yields an identical
 * event sequence (golden-sample regression: `controlModeDecoder.test.ts`).
 *
 * ## Never truncate output
 *
 * An over-long `%output` line is emitted as several consecutive `output`
 * events (`maxOutputChunkBytes` bounds one event, not the line). Dropping
 * bytes would tear an escape sequence apart — same iron law as
 * `termWriteHold`'s "chunk boundaries preserved verbatim".
 *
 * No I/O, no subprocesses, no timers: pure state machine, unit-testable.
 */

/** Pane output (a `%output`, or a `%extended-output` when `age` is set). */
export interface ControlModeOutputEvent {
    type: 'output';
    /** Pane id including its leading `%`, e.g. `%0`. */
    pane: string;
    /** Decoded raw pane bytes. Never valid-UTF-8-assumed, never a string. */
    data: Buffer;
    /** Only for `%extended-output` (pause-after / flow-control mode): tmux's
     *  reported age in ms of the buffered data at write time. */
    age?: number;
}

/** A completed `%begin`…`%end`/`%error` command output block. */
export interface ControlModeBlockEvent {
    type: 'block';
    /** `%begin` arg 1 — tmux's `item->time` (seconds). */
    epoch: number;
    /** `%begin` arg 2 — tmux's monotonic command number. */
    cmdNum: number;
    /** `%begin` arg 3, verbatim (`%end`/`%error` repeats it). */
    flags: number;
    /** `(flags & 1) === 1` — see the file header. FALSE for the attach
     *  greeting AND for hook-triggered blocks; only TRUE blocks may be
     *  FIFO-matched against commands written to this client's stdin. */
    solicited: boolean;
    /** Closed by `%error` rather than `%end`. */
    error: boolean;
    /** Raw block bytes, each body line including its terminating LF. Empty
     *  Buffer for an empty block (the greeting). ESC is NOT escaped in here. */
    body: Buffer;
    /** `maxBlockBytes` was hit; body was cut at a line boundary. */
    truncated: boolean;
}

/** Any other `%name args...` line (`%layout-change`, `%exit`, `%pause`, …). */
export interface ControlModeNotificationEvent {
    type: 'notification';
    /** Name without the leading `%`, e.g. `layout-change`. */
    name: string;
    /** Everything after the first space, verbatim (empty string if none). */
    args: string;
}

export type ControlModeProtocolErrorReason =
    /** `%end`/`%error` seen with no block open. */
    | 'stray-end'
    /** A line outside any block that does not start with `%`. */
    | 'stray-line'
    /** `%begin` line whose epoch/cmdNum did not parse as numbers. */
    | 'bad-begin'
    /** Stream ended inside an open block. */
    | 'unterminated-block'
    /** Stream ended mid-line; whatever was decoded has already been emitted. */
    | 'unterminated-line'
    /** A single line exceeded `maxLineBytes`; the parser resynced at the next LF. */
    | 'line-too-long';

/**
 * Something the stream should not contain. Emitted instead of throwing so a
 * single malformed line can never take the daemon down or swallow the rest of
 * the stream; the parser always resynchronises on the next LF.
 */
export interface ControlModeProtocolErrorEvent {
    type: 'protocol-error';
    reason: ControlModeProtocolErrorReason;
    /** Short human-readable context (already sanitised, safe to log). */
    detail: string;
}

export type ControlModeEvent =
    | ControlModeOutputEvent
    | ControlModeBlockEvent
    | ControlModeNotificationEvent
    | ControlModeProtocolErrorEvent;

export interface ControlModeDecoderOptions {
    /** Max decoded bytes carried by ONE `output` event. A longer `%output`
     *  line is split across consecutive events — never truncated. Default 64 KiB.
     *  (tmux itself caps a line at CONTROL_BUFFER_HIGH = 8 KiB of pane data,
     *  so this only bites on a future//patched tmux.) */
    maxOutputChunkBytes?: number;
    /** Safety cap on one block body. Excess is dropped at LINE boundaries and
     *  `truncated` is set (cutting mid-line would tear escape sequences —
     *  spec A4). Default 16 MiB. */
    maxBlockBytes?: number;
    /** Safety cap on a single unterminated line held in memory. On overflow the
     *  parser emits `line-too-long` and discards up to the next LF. Default
     *  4 MiB — three orders of magnitude above anything tmux emits. */
    maxLineBytes?: number;
}

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const COLON = 0x3a;
const PERCENT = 0x25;
const BACKSLASH = 0x5c;
const ZERO = 0x30;
const SEVEN = 0x37;

const DEFAULT_MAX_OUTPUT_CHUNK = 64 * 1024;
const DEFAULT_MAX_BLOCK = 16 * 1024 * 1024;
const DEFAULT_MAX_LINE = 4 * 1024 * 1024;

/** Longest plausible `%extended-output %1234 18446744073709551615 : ` prefix. */
const MAX_HEADER_SCAN = 96;

const EMPTY = Buffer.alloc(0);

interface OpenBlock {
    epoch: number;
    cmdNum: number;
    flags: number;
    parts: Buffer[];
    bytes: number;
    truncated: boolean;
}

interface OutputContext {
    pane: string;
    age?: number;
}

/**
 * Streaming decoder. One instance per control client connection; feed every
 * stdout chunk to `push()` in order and act on the returned events. Call
 * `flush()` once the child's stdout closes so a half-line is not silently lost.
 */
export class ControlModeDecoder {
    private readonly maxOutputChunkBytes: number;
    private readonly maxBlockBytes: number;
    private readonly maxLineBytes: number;

    /** Unconsumed bytes (always a short remainder — see the header's note on
     *  memory: block bodies drain into `block.parts`, output payloads drain
     *  into `acc`, so nothing but a partial line ever sits here). */
    private pending: Buffer = EMPTY;
    /** Open `%begin` block, if any. */
    private block: OpenBlock | null = null;
    /** Set while consuming a `%output`/`%extended-output` payload. */
    private out: OutputContext | null = null;
    /** Decoded-payload accumulator for the current output line. */
    private readonly acc: Buffer;
    private accLen = 0;
    /** Shared `\ooo` unescaper (the single implementation — see unescapeOctal). */
    private readonly esc = new OctalUnescaper();
    /** Events being built by the in-flight push()/flush() call — the sink needs
     *  somewhere to put a chunk when the accumulator fills mid-line. */
    private target: ControlModeEvent[] = [];
    private readonly sink = (byte: number): void => {
        this.acc[this.accLen++] = byte;
        if (this.accLen === this.acc.length) this.emitAcc();
    };
    /** Discarding bytes until the next LF after a `line-too-long`. */
    private resyncing = false;

    constructor(options: ControlModeDecoderOptions = {}) {
        this.maxOutputChunkBytes = options.maxOutputChunkBytes ?? DEFAULT_MAX_OUTPUT_CHUNK;
        this.maxBlockBytes = options.maxBlockBytes ?? DEFAULT_MAX_BLOCK;
        this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE;
        this.acc = Buffer.allocUnsafe(this.maxOutputChunkBytes);
    }

    /** True while inside an unterminated `%begin` block (diagnostics). */
    get inBlock(): boolean {
        return this.block !== null;
    }

    /** Bytes buffered but not yet turned into events (diagnostics). */
    get pendingBytes(): number {
        return this.pending.length + this.accLen + (this.block?.bytes ?? 0);
    }

    /**
     * Feed one stdout chunk. Returns the events it completed, in stream order.
     * Any chunking of the same byte stream produces the same event sequence.
     */
    push(chunk: Buffer): ControlModeEvent[] {
        const events: ControlModeEvent[] = [];
        this.target = events;
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        let cursor = 0;
        const buf = this.pending;

        for (;;) {
            if (this.resyncing) {
                const nl = buf.indexOf(LF, cursor);
                if (nl < 0) { cursor = buf.length; break; }
                this.resyncing = false;
                cursor = nl + 1;
                continue;
            }
            if (this.out !== null) {
                const nl = buf.indexOf(LF, cursor);
                if (nl < 0) {
                    // Hold back a trailing CR — it may turn out to be half of a
                    // CRLF terminator once the next chunk arrives. Safe either
                    // way: tmux escapes every payload byte < 0x20, so a RAW CR
                    // here is never payload.
                    const end = buf.length > cursor && buf[buf.length - 1] === CR ? buf.length - 1 : buf.length;
                    this.esc.feed(buf, cursor, end, this.sink);
                    cursor = end;
                    break; // payload continues in a later chunk
                }
                this.esc.feed(buf, cursor, nl > cursor && buf[nl - 1] === CR ? nl - 1 : nl, this.sink);
                this.esc.finish(this.sink);
                this.emitAcc();
                this.out = null;
                cursor = nl + 1;
                continue;
            }
            if (this.block !== null) {
                const nl = buf.indexOf(LF, cursor);
                if (nl < 0) break;
                this.consumeBlockLine(buf.subarray(cursor, nl), events);
                cursor = nl + 1;
                continue;
            }
            const header = matchOutputHeader(buf, cursor);
            if (header !== null) {
                this.out = { pane: header.pane, age: header.age };
                cursor = header.end;
                continue;
            }
            const nl = buf.indexOf(LF, cursor);
            if (nl < 0) break;
            this.consumeControlLine(buf.subarray(cursor, nl), events);
            cursor = nl + 1;
        }

        this.pending = cursor >= buf.length ? EMPTY : Buffer.from(buf.subarray(cursor));
        if (this.pending.length > this.maxLineBytes) {
            events.push({
                type: 'protocol-error',
                reason: 'line-too-long',
                detail: `dropped ${this.pending.length} buffered bytes, resyncing at next LF`,
            });
            if (this.block !== null) this.block.truncated = true;
            this.pending = EMPTY;
            this.resyncing = true;
        }
        return events;
    }

    /**
     * Signal end of stream. Emits whatever survived (a partial output payload
     * is emitted rather than dropped — losing bytes is worse than a short
     * chunk) plus a protocol-error describing what was cut off.
     */
    flush(): ControlModeEvent[] {
        const events: ControlModeEvent[] = [];
        this.target = events;
        if (this.out !== null) {
            this.esc.finish(this.sink);
            this.emitAcc();
            const pane = this.out.pane;
            this.out = null;
            events.push({
                type: 'protocol-error',
                reason: 'unterminated-line',
                detail: `stream ended inside %output for pane ${pane}`,
            });
        } else if (this.pending.length > 0) {
            events.push({
                type: 'protocol-error',
                reason: 'unterminated-line',
                detail: `stream ended with ${this.pending.length} bytes of an unterminated line`,
            });
        }
        if (this.block !== null) {
            const block = this.block;
            this.block = null;
            events.push({
                type: 'protocol-error',
                reason: 'unterminated-block',
                detail: `stream ended inside block ${block.epoch}/${block.cmdNum} (${block.bytes} body bytes)`,
            });
        }
        this.pending = EMPTY;
        return events;
    }

    /**
     * Emit the accumulated payload as one `output` event. Called both when a
     * payload line ends and whenever the accumulator fills up mid-line — the
     * latter is how an over-long `%output` becomes several consecutive events
     * with not one byte lost.
     */
    private emitAcc(): void {
        if (this.accLen === 0) return;
        const out = this.out;
        const data = Buffer.from(this.acc.subarray(0, this.accLen));
        this.accLen = 0;
        this.target.push(out?.age === undefined
            ? { type: 'output', pane: out?.pane ?? '', data }
            : { type: 'output', pane: out.pane, data, age: out.age });
    }

    /** One raw line while a block is open: terminator, or body bytes. */
    private consumeBlockLine(line: Buffer, events: ControlModeEvent[]): void {
        const block = this.block!;
        const guard = matchBlockGuard(line);
        if (guard !== null && guard.epoch === block.epoch && guard.cmdNum === block.cmdNum) {
            this.block = null;
            events.push({
                type: 'block',
                epoch: block.epoch,
                cmdNum: block.cmdNum,
                flags: block.flags,
                solicited: (block.flags & 1) === 1,
                error: guard.error,
                body: block.parts.length === 0 ? EMPTY : Buffer.concat(block.parts, block.bytes),
                truncated: block.truncated,
            });
            return;
        }
        const next = block.bytes + line.length + 1;
        if (next > this.maxBlockBytes) {
            block.truncated = true;
            return;
        }
        block.parts.push(Buffer.from(line), LF_BUF);
        block.bytes = next;
    }

    /** One `%…` line outside any block. */
    private consumeControlLine(rawLine: Buffer, events: ControlModeEvent[]): void {
        const line = rawLine.length > 0 && rawLine[rawLine.length - 1] === CR
            ? rawLine.subarray(0, rawLine.length - 1)
            : rawLine;
        if (line.length === 0) return;
        if (line[0] !== PERCENT) {
            events.push({
                type: 'protocol-error',
                reason: 'stray-line',
                detail: `non-% line outside a block: ${previewAscii(line)}`,
            });
            return;
        }
        const sp = line.indexOf(SPACE);
        const name = line.toString('latin1', 1, sp < 0 ? line.length : sp);
        const args = sp < 0 ? '' : line.toString('utf8', sp + 1);

        if (name === 'begin') {
            const guard = parseGuardArgs(args);
            if (guard === null) {
                events.push({ type: 'protocol-error', reason: 'bad-begin', detail: previewAscii(line) });
                return;
            }
            this.block = {
                epoch: guard.epoch,
                cmdNum: guard.cmdNum,
                flags: guard.flags,
                parts: [],
                bytes: 0,
                truncated: false,
            };
            return;
        }
        if (name === 'end' || name === 'error') {
            events.push({
                type: 'protocol-error',
                reason: 'stray-end',
                detail: `%${name} with no open block: ${previewAscii(line)}`,
            });
            return;
        }
        events.push({ type: 'notification', name, args });
    }
}

const LF_BUF = Buffer.from([LF]);

/**
 * Incremental `\ooo` unescaper — THE single implementation of tmux's octal
 * escaping, shared by the `%output` path above and by the one-shot
 * `unescapeOctal()` below. Carries a half-seen escape across `feed()` calls,
 * which is what makes an arbitrary chunk boundary inside `\015` harmless.
 */
class OctalUnescaper {
    /** -1 = not escaping; 0..2 = octal digits collected after a backslash. */
    private digits = -1;
    private value = 0;

    /** Decode `buf[from, to)` into `sink`, one byte at a time. */
    feed(buf: Buffer, from: number, to: number, sink: (byte: number) => void): void {
        let i = from;
        while (i < to) {
            const b = buf[i]!;
            if (this.digits < 0) {
                if (b === BACKSLASH) { this.digits = 0; this.value = 0; } else sink(b);
                i += 1;
                continue;
            }
            if (b >= ZERO && b <= SEVEN) {
                this.value = this.value * 8 + (b - ZERO);
                this.digits += 1;
                i += 1;
                if (this.digits === 3) {
                    sink(this.value & 0xff);
                    this.digits = -1;
                    this.value = 0;
                }
                continue;
            }
            // Malformed: tmux always writes exactly three octal digits
            // (control.c and cmd-capture-pane.c alike). Recover leniently —
            // replay the bytes we swallowed verbatim and reprocess `b` from
            // scratch. Never drop input: a lost byte tears an escape sequence.
            this.replay(sink);
        }
    }

    /** End of input: a dangling `\`, `\0`, `\01` is emitted verbatim. */
    finish(sink: (byte: number) => void): void {
        if (this.digits >= 0) this.replay(sink);
    }

    private replay(sink: (byte: number) => void): void {
        const digits = this.digits;
        const value = this.value;
        this.digits = -1;
        this.value = 0;
        sink(BACKSLASH);
        for (let d = digits - 1; d >= 0; d--) sink(ZERO + ((value >> (3 * d)) & 0o7));
    }
}

/**
 * Undo tmux's octal escaping over a complete buffer: `\ooo` (three octal
 * digits) becomes that byte, everything else passes through verbatim. Binary
 * safe — in and out are `Buffer`s, never strings.
 *
 * Two tmux sites produce this encoding with a **byte-identical rule**
 * (`byte < 0x20 || byte == '\\'` -> `\%03o`), verified in 3.6a/master source
 * and on this machine:
 *
 *   - `control.c:control_append_data` — `%output` payloads;
 *   - `cmd-capture-pane.c` under `-C` — e.g. the `capture-pane -p -P -C`
 *     "unfinished escape sequence tail" the v2 screen assembly needs.
 *
 * So a backslash IS escaped in both (as `\134`), and bytes >= 0x80 are NOT
 * (measured: CJK survives `-C` unescaped). Should some platform's signed-`char`
 * build escape >= 0x80 as well, this function still decodes it correctly —
 * `\200`..`\377` round-trip like any other value.
 *
 * Malformed input (a short escape like `\12x`, or a trailing `\`) is recovered
 * leniently: the swallowed bytes come back out verbatim rather than being
 * dropped, because dropping a byte is how you tear an escape sequence in half.
 */
export function unescapeOctal(buf: Buffer): Buffer {
    if (buf.indexOf(BACKSLASH) < 0) return buf;
    const out = Buffer.allocUnsafe(buf.length);
    let n = 0;
    const sink = (byte: number): void => { out[n++] = byte; };
    const esc = new OctalUnescaper();
    esc.feed(buf, 0, buf.length, sink);
    esc.finish(sink);
    return Buffer.from(out.subarray(0, n));
}

interface GuardArgs {
    epoch: number;
    cmdNum: number;
    flags: number;
}

/** `<epoch> <cmdNum> <flags>` — all three required and numeric. */
function parseGuardArgs(args: string): GuardArgs | null {
    const parts = args.split(' ');
    if (parts.length < 3) return null;
    const epoch = Number(parts[0]);
    const cmdNum = Number(parts[1]);
    const flags = Number(parts[2]);
    if (!Number.isFinite(epoch) || !Number.isFinite(cmdNum) || !Number.isFinite(flags)) return null;
    if (parts[0]!.length === 0 || parts[1]!.length === 0 || parts[2]!.length === 0) return null;
    return { epoch, cmdNum, flags };
}

/**
 * Is this body line an `%end`/`%error` guard? The caller still checks the
 * numbers against the OPEN block — a capture whose text happens to contain
 * `%end 1 2 3` must stay body bytes.
 */
function matchBlockGuard(rawLine: Buffer): (GuardArgs & { error: boolean }) | null {
    const line = rawLine.length > 0 && rawLine[rawLine.length - 1] === CR
        ? rawLine.subarray(0, rawLine.length - 1)
        : rawLine;
    if (line.length < 6 || line[0] !== PERCENT) return null;
    const sp = line.indexOf(SPACE);
    if (sp < 0) return null;
    const name = line.toString('latin1', 1, sp);
    if (name !== 'end' && name !== 'error') return null;
    const guard = parseGuardArgs(line.toString('latin1', sp + 1));
    if (guard === null) return null;
    return { ...guard, error: name === 'error' };
}

interface OutputHeader {
    pane: string;
    age?: number;
    /** Offset of the first payload byte. */
    end: number;
}

/**
 * Match a COMPLETE `%output %<pane> ` / `%extended-output %<pane> <age> : `
 * prefix at `start`. Returns null when the prefix is absent OR still
 * incomplete — the caller then waits for more bytes, which is what makes a
 * chunk boundary inside the header harmless.
 */
function matchOutputHeader(buf: Buffer, start: number): OutputHeader | null {
    if (start >= buf.length || buf[start] !== PERCENT) return null;
    const limit = Math.min(buf.length, start + MAX_HEADER_SCAN);

    const nameEnd = scanToken(buf, start + 1, limit);
    if (nameEnd < 0) return null;
    const name = buf.toString('latin1', start + 1, nameEnd);
    const extended = name === 'extended-output';
    if (!extended && name !== 'output') return null;

    const paneEnd = scanToken(buf, nameEnd + 1, limit);
    if (paneEnd < 0) return null;
    if (buf[nameEnd + 1] !== PERCENT) return null;
    const pane = buf.toString('latin1', nameEnd + 1, paneEnd);
    if (!extended) return { pane, end: paneEnd + 1 };

    const ageEnd = scanToken(buf, paneEnd + 1, limit);
    if (ageEnd < 0) return null;
    const age = Number(buf.toString('latin1', paneEnd + 1, ageEnd));
    if (!Number.isFinite(age)) return null;
    if (ageEnd + 2 >= buf.length) return null;
    if (buf[ageEnd + 1] !== COLON || buf[ageEnd + 2] !== SPACE) return null;
    return { pane, age, end: ageEnd + 3 };
}

/**
 * Index of the SPACE ending the token at `from`, or -1 when the token is
 * unterminated within `limit` / the line ended first.
 */
function scanToken(buf: Buffer, from: number, limit: number): number {
    for (let i = from; i < limit; i++) {
        const b = buf[i]!;
        if (b === SPACE) return i === from ? -1 : i;
        if (b === LF) return -1;
    }
    return -1;
}

/** Short printable preview for protocol-error details (never leaks raw bytes). */
function previewAscii(line: Buffer): string {
    const slice = line.subarray(0, 80);
    let out = '';
    for (const b of slice) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    return line.length > 80 ? `${out}…` : out;
}
