/**
 * Deep-history assembly state machine for the v2 terminal channel
 * (spec 2026-08-terminal-channel-v2 §D1「传输与重建」/「assembly 状态机」).
 *
 * ── What it exists for ────────────────────────────────────────────────────
 * In `streamMode:'lines'` the daemon answers an open with a SMALL snapshot
 * (~300 lines — the screen appears instantly) plus a `snapshotId` naming a FULL
 * capture it is holding in memory, split into `totalPages`. The client pulls
 * those pages in the background and, at a quiet moment, atomically REBUILDS the
 * screen: reset → history pages → the live chunks that arrived since. That is
 * how a mobile client that was backgrounded all night gets its scrollback back
 * without ever showing a blank or a torn screen.
 *
 * The whole thing hangs on two rules the spec calls out as self-destruct points
 * if broken, so they are encoded HERE rather than in the screen component:
 *
 *  1. **The copy rule is independent of the state.** Every live chunk that is
 *     APPLIED after the baseline was assigned (seq > S0) is copied the moment it
 *     is applied, and stays copied through page fetching AND through the quiet
 *     gate's suspension, until done/abort releases everything. Miss one chunk
 *     and the rebuilt screen forks from the real one permanently — the rebuild
 *     replaces everything below the capture point, so a chunk that was written
 *     but not copied is simply erased.
 *
 *  2. **Live chunks keep flowing through the normal seq path during a rebuild.**
 *     Only their WRITE is deferred (queued here, flushed in order right after
 *     the rebuild) — `termStreamSync.liveChunk` still runs for every one of
 *     them, so `lastSeq` advances and gap detection stays live. The tempting
 *     shortcut (route everything raw while rebuilding) freezes `lastSeq`: the
 *     first normal chunk after the rebuild is then judged a gap, catch-up
 *     resets the screen and wipes the deep history that was just assembled.
 *
 * ── Transition table (the only legal moves) ───────────────────────────────
 *   idle ──start(totalPages>0)──▶ buffering        (generation++)
 *   idle ──start(totalPages<=0)─▶ done             (nothing to assemble)
 *   buffering ──pageArrived(last page)──▶ awaiting-quiet
 *   buffering / awaiting-quiet ──noteLiveChunk──▶ same state, chunk WRITTEN + copied
 *   awaiting-quiet ──tryRebuild(quiet=false)──▶ awaiting-quiet (suspended)
 *   awaiting-quiet ──tryRebuild(quiet=true)───▶ rebuilding  (+ plan)
 *   rebuilding ──noteLiveChunk──▶ rebuilding, chunk DEFERRED
 *   rebuilding ──finishRebuild──▶ done  (deferred chunks handed back to write)
 *   any ──abort(gap | snapshot-expired | page-failed | buffer-overflow |
 *              superseded | initial-timeout | disposed)──▶ done
 * `done`/`idle` are inert: chunks are written straight through, nothing is kept.
 * Aborting never needs an undo — the small snapshot is already on screen and
 * stays there (功能完好，仅历史浅), and seq bookkeeping went down the normal
 * path the whole time.
 *
 * ── Buffer bounds ─────────────────────────────────────────────────────────
 * The main use case of this feature (scroll back while output keeps coming) is
 * exactly the one where an unbounded live buffer dies, so the live copy/defer
 * buffer is capped at 2MB — the same order as the daemon's ring. Page bytes get
 * their own budget of the same size: the daemon's capture budget is 1MB total
 * (≤256KB/page), so 2MB is a sanity belt against a misbehaving peer, not a
 * working limit. Either overflow aborts the assembly (→ small-snapshot shape).
 *
 * This module is pure: no DOM, no xterm, no RPC. It decides; the screen writes.
 */

/** Live copy/defer buffer cap, and (separately) the page buffer cap. */
export const ASSEMBLY_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export type AssemblyState = 'idle' | 'buffering' | 'awaiting-quiet' | 'rebuilding' | 'done';

export type AssemblyAbortReason =
    /** a hole in the live stream → catch-up owns the screen from here */
    | 'gap'
    /** the daemon dropped/replaced the held capture (`snapshot-expired`) */
    | 'snapshot-expired'
    /** a page request failed past its retry */
    | 'page-failed'
    /** live or page buffer exceeded its cap */
    | 'buffer-overflow'
    /** a newer assembly started (new open/catch-up snapshot) */
    | 'superseded'
    /** the first-paint stability budget expired; keep the small snapshot */
    | 'initial-timeout'
    /** the terminal screen unmounted */
    | 'disposed';

export interface AssemblyStartInput {
    /** Daemon-side id of the held full capture; page requests must echo it. */
    snapshotId: string;
    totalPages: number;
}

/**
 * What the screen must write, in this order, inside ONE outChain slot:
 * `term.reset()` → every `pages[i]` → every `copies[i]`. All of these are RAW
 * writes that bypass seq judgement (they are history and already-applied
 * replays, not new stream content) — the only writes in the whole client that
 * are allowed to.
 */
export interface AssemblyRebuildPlan {
    pages: Uint8Array[];
    copies: Uint8Array[];
}

export type PageOutcome = 'ok' | 'stale' | 'duplicate';

export interface TermAssembly {
    readonly state: AssemblyState;
    readonly snapshotId: string | null;
    /** Bumped by every start(); page arrivals from an older run are dropped. */
    readonly generation: number;
    readonly totalPages: number;
    readonly pagesReceived: number;
    readonly liveBytes: number;
    readonly pageBytes: number;
    readonly lastAbortReason: AssemblyAbortReason | null;

    /**
     * Begin an assembly for a freshly applied lines-mode snapshot. Supersedes
     * any run in flight. Returns false (and lands in `done`) when there is
     * nothing to assemble — `totalPages <= 0` or no snapshotId.
     */
    start(input: AssemblyStartInput): boolean;
    /**
     * A history page came back. `generation` is what `start()` returned via
     * `assembly.generation` when the request was issued — a page from an older
     * run (or arriving outside `buffering`) is 'stale' and dropped.
     */
    pageArrived(generation: number, page: number, data: Uint8Array): PageOutcome;
    /**
     * A live chunk that `termStreamSync` decided to APPLY is about to be
     * written. Returns the chunks to write NOW, in order:
     *  - `[data]`   — normal (inert, buffering or awaiting-quiet; a copy is kept)
     *  - `[]`       — deferred (a rebuild is in flight)
     *  - `[…deferred, data]` — an overflow aborted mid-rebuild: everything that
     *    was deferred must still be written, because its seq was already
     *    accepted and no catch-up will ever replay it.
     */
    noteLiveChunk(data: Uint8Array): Uint8Array[];
    /**
     * Quiet-moment gate. `quiet` = "the user is not selecting AND the viewport
     * is at the bottom" — a rebuild resets the screen, which would destroy a
     * selection and yank a scrolled-back viewport. Returns the rebuild plan
     * (and enters `rebuilding`) only when all pages are in and `quiet`.
     */
    tryRebuild(quiet: boolean): AssemblyRebuildPlan | null;
    /** The rebuild writes are done → release; returns the deferred chunks. */
    finishRebuild(): Uint8Array[];
    /** Give up. Returns chunks that were deferred and MUST still be written. */
    abort(reason: AssemblyAbortReason): Uint8Array[];
}

export function createTermAssembly(
    maxBufferBytes: number = ASSEMBLY_MAX_BUFFER_BYTES,
): TermAssembly {
    let state: AssemblyState = 'idle';
    let snapshotId: string | null = null;
    let generation = 0;
    let totalPages = 0;
    let pages: Array<Uint8Array | null> = [];
    let pagesReceived = 0;
    let pageBytes = 0;
    /** Live chunks written while buffering — replayed after the history. */
    let copies: Uint8Array[] = [];
    /** Live chunks held back during the rebuild — written straight after it. */
    let deferred: Uint8Array[] = [];
    let liveBytes = 0;
    let lastAbortReason: AssemblyAbortReason | null = null;

    const release = (): Uint8Array[] => {
        const pending = deferred;
        state = 'done';
        snapshotId = null;
        totalPages = 0;
        pages = [];
        pagesReceived = 0;
        pageBytes = 0;
        copies = [];
        deferred = [];
        liveBytes = 0;
        return pending;
    };

    return {
        get state() { return state; },
        get snapshotId() { return snapshotId; },
        get generation() { return generation; },
        get totalPages() { return totalPages; },
        get pagesReceived() { return pagesReceived; },
        get liveBytes() { return liveBytes; },
        get pageBytes() { return pageBytes; },
        get lastAbortReason() { return lastAbortReason; },

        start(input) {
            // A new snapshot replaces whatever was in flight: its pages belong
            // to an older capture and its copies predate the new baseline.
            release();
            generation += 1;
            lastAbortReason = null;
            // Nothing to assemble (a daemon that held no full capture, or a
            // terminal with no history yet) — stay inert in `done`.
            if (!input.snapshotId || input.totalPages <= 0) return false;
            snapshotId = input.snapshotId;
            totalPages = input.totalPages;
            pages = new Array<Uint8Array | null>(input.totalPages).fill(null);
            state = 'buffering';
            return true;
        },

        pageArrived(gen, page, data) {
            if (gen !== generation || state !== 'buffering') return 'stale';
            if (page < 0 || page >= totalPages) return 'stale';
            if (pages[page] != null) return 'duplicate';
            pages[page] = data;
            pagesReceived += 1;
            pageBytes += data.byteLength;
            if (pageBytes > maxBufferBytes) {
                lastAbortReason = 'buffer-overflow';
                release();
                return 'stale';
            }
            if (pagesReceived === totalPages) state = 'awaiting-quiet';
            return 'ok';
        },

        noteLiveChunk(data) {
            if (state === 'idle' || state === 'done') return [data];
            if (state === 'rebuilding') {
                deferred.push(data);
                liveBytes += data.byteLength;
                if (liveBytes > maxBufferBytes) {
                    // Everything deferred was already counted in `lastSeq`, so
                    // dropping it would punch a hole no catch-up can fill —
                    // hand it all back to be written, then give up.
                    lastAbortReason = 'buffer-overflow';
                    return release();
                }
                return [];
            }
            // buffering / awaiting-quiet: on screen now, and kept for the replay.
            copies.push(data);
            liveBytes += data.byteLength;
            if (liveBytes > maxBufferBytes) {
                lastAbortReason = 'buffer-overflow';
                release();
            }
            return [data];
        },

        tryRebuild(quiet) {
            if (state !== 'awaiting-quiet' || !quiet) return null;
            const plan: AssemblyRebuildPlan = {
                pages: pages.filter((p): p is Uint8Array => p != null),
                copies: copies.slice(),
            };
            state = 'rebuilding';
            return plan;
        },

        finishRebuild() {
            if (state !== 'rebuilding') return [];
            return release();
        },

        abort(reason) {
            if (state === 'idle' || state === 'done') return [];
            lastAbortReason = reason;
            return release();
        },
    };
}

/** `\x1b[?1049h` — enter the alternate screen. */
export const ALT_SCREEN_ENTER = new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]);

/**
 * Lines-mode snapshots carry `alternateOn`: the pane was on the alternate
 * screen when the capture ran, and the small snapshot is just its visible area
 * — with no `\x1b[?1049h` in front of it, xterm applies that content to the
 * NORMAL buffer. Two things break at once: the alt content pollutes the local
 * scrollback this whole feature exists to build, and the screen's two-track
 * scroll logic reads the wrong track (native scrolling in a TUI) until the deep
 * rebuild lands seconds later.
 *
 * Idempotent by construction: if the payload already begins with the enter
 * sequence (a daemon that prefixes it itself), nothing is added — so the
 * consumer is correct whichever side of the wire owns the prefix.
 */
export function prefixAlternateEnter(data: Uint8Array, alternateOn: boolean): Uint8Array {
    if (!alternateOn) return data;
    if (startsWithAltEnter(data)) return data;
    const out = new Uint8Array(ALT_SCREEN_ENTER.length + data.length);
    out.set(ALT_SCREEN_ENTER, 0);
    out.set(data, ALT_SCREEN_ENTER.length);
    return out;
}

function startsWithAltEnter(data: Uint8Array): boolean {
    if (data.length < ALT_SCREEN_ENTER.length) return false;
    for (let i = 0; i < ALT_SCREEN_ENTER.length; i++) {
        if (data[i] !== ALT_SCREEN_ENTER[i]) return false;
    }
    return true;
}
