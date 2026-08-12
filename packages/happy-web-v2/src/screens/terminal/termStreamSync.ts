/**
 * Seq bookkeeping for the daemon-authoritative terminal output stream —
 * extracted state machine (same pattern as termWriteHold / termFocusPolicy).
 *
 * The daemon assigns a monotonic `seq` to every pty output chunk and keeps a
 * ring buffer for gap replay; the client tracks the highest seq it has applied
 * (`lastSeq`) so a re-subscribe can ask for `fromSeq=lastSeq`. Three real
 * failure modes drove pulling this logic out of the screen component
 * (all observed as "切换到终端后画面不重绘/空白/幽灵字符" in the wild):
 *
 * 1. STALE BASELINE FREEZE (the worst one). The old code did
 *    `lastSeq = Math.max(lastSeq, snapshot.seq)` after applying a snapshot.
 *    But the daemon RECREATES a session with a seq counter RESTARTED AT 0
 *    whenever the pty was reaped (idle + 0 subscribers — daemon logs show this
 *    routinely: `detached pty X` … later `opened X`) or the daemon restarted.
 *    A client that held e.g. lastSeq=500 from the previous generation then
 *    caught up against the new generation: snapshot seq is ~0, Math.max keeps
 *    500, and EVERY subsequent live chunk (seq 1, 2, 3 …) is "already seen" →
 *    silently dropped. Screen frozen: no redraw, no echo for anything typed
 *    (reads as "中文打不进去" — the IME bubble is local, the echo never comes).
 *    Fix: a snapshot REPLACES the screen, so its seq is ASSIGNED as the new
 *    baseline, never maxed. The one exception is chunks accepted while the
 *    catch-up RPC was in flight (they are same-generation — a cross-generation
 *    chunk can't advance the stale baseline because it deduped below it — and
 *    strictly newer than the snapshot): keep the higher of the two, which is
 *    what `seqAtCall` distinguishes.
 *
 * 2. MID-STREAM HOLES TEAR ESCAPE SEQUENCES. The old code accepted any chunk
 *    with `seq > lastSeq`, so after a dropped chunk the next one was written
 *    anyway. tmux redraws are DELTAS against its own screen model: lose one
 *    chunk and xterm's screen diverges from tmux's model in cells tmux now
 *    believes are up to date — it will never repaint them. That divergence is
 *    exactly the reported "怎么也删不掉的字母" (a ghost char tmux doesn't know
 *    about) and "停在旧内容" (a lost repaint region). A hole can also split a
 *    multi-byte escape sequence and dump garbage as text. Fix: a non-contiguous
 *    chunk is NOT written ('gap'); the caller resyncs via catch-up (the daemon
 *    replays the hole from its ring, or sends a fresh snapshot).
 *
 * 3. MOUNT-WINDOW CHUNK LOSS. Chunks that arrive between the daemon computing
 *    the open snapshot and the client learning its terminalId were dropped
 *    outright (the RPC ack's payload decrypt is async; socket events can be
 *    processed first). That's the screen component's stash-and-flush job, but
 *    the flush funnels through liveChunk() here so the dedup/gap rules apply.
 */

export type LiveDecision = 'apply' | 'dup' | 'gap';

export interface TermStreamSync {
    /** Highest seq applied — the `fromSeq` for the next catch-up. */
    readonly lastSeq: number;
    /**
     * A live `terminal-output` chunk arrived.
     *  - 'apply': contiguous → write it (baseline advanced)
     *  - 'dup':   already covered by a snapshot/replay/earlier chunk → drop
     *  - 'gap':   a hole precedes it → do NOT write (see header §2); trigger a
     *             catch-up instead
     * Chunks without a seq (legacy daemon) are always applied and never move
     * the baseline.
     */
    liveChunk(seq: number | undefined): LiveDecision;
    /**
     * A full snapshot was accepted (initial open or catch-up fallback).
     * `seqAtCall` is what `lastSeq` was when the RPC was ISSUED — pass 0 for a
     * fresh mount. Assigns the baseline (never maxes — header §1), except that
     * chunks accepted in flight (lastSeq moved past seqAtCall) stay covered.
     */
    snapshotApplied(snapshotSeq: number, seqAtCall: number): void;
    /** One replay chunk: true → write it (baseline advanced), false → drop. */
    replayChunk(seq: number): boolean;
    /** Replay finished: adopt the daemon's reported seq if it's ahead (covers
     *  an empty replay — daemon idle since fromSeq). Replay implies the same
     *  generation (the ring covered fromSeq), so max is safe here. */
    replayDone(daemonSeq: number): void;
}

export function createTermStreamSync(): TermStreamSync {
    let lastSeq = 0;
    return {
        get lastSeq() {
            return lastSeq;
        },
        liveChunk(seq) {
            if (typeof seq !== 'number') return 'apply';
            if (seq <= lastSeq) return 'dup';
            if (seq > lastSeq + 1) return 'gap';
            lastSeq = seq;
            return 'apply';
        },
        snapshotApplied(snapshotSeq, seqAtCall) {
            lastSeq = lastSeq > seqAtCall
                ? Math.max(snapshotSeq, lastSeq) // in-flight same-generation chunks stay covered
                : snapshotSeq; // ASSIGN — daemon seq may have restarted (see header §1)
        },
        replayChunk(seq) {
            if (seq <= lastSeq) return false;
            lastSeq = seq;
            return true;
        },
        replayDone(daemonSeq) {
            lastSeq = Math.max(lastSeq, daemonSeq);
        },
    };
}
