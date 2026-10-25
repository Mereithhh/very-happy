/**
 * B-805: what a live `new-message` update does to its session's message state.
 *
 * Before B-805 every update also invalidated the messages sync, so each
 * realtime message — of ANY session this tab knew — cost one `after_seq` GET
 * that almost always came back empty (production ≈200–270/min, B-802
 * DESIGN-REVIEW §2.3-1). The update itself is authoritative: only a hole in
 * the seq run (or a reconnect, handled elsewhere) needs the server.
 *
 *  - `apply`   seq is exactly lastSeq + 1: reduce it, advance lastSeq. No GET.
 *  - `echo`    seq <= lastSeq: already reduced (relay delivered it first). No GET.
 *  - `refetch` a gap in an anchored session: one forward fetch.
 *  - `defer`   no anchor yet (the latest page was never loaded in this tab, or
 *              is loading): buffer it until that page lands — see
 *              `AnchorBuffer`. Never a GET of its own.
 */
export type LiveMessageAction = 'apply' | 'echo' | 'refetch' | 'defer';

export function planLiveMessage(lastSeq: number | undefined, seq: number): LiveMessageAction {
    if (lastSeq === undefined) return 'defer';
    if (seq === lastSeq + 1) return 'apply';
    if (seq <= lastSeq) return 'echo';
    return 'refetch';
}

/** Past this many buffered updates a session drops the rest (they become a gap → one forward fetch). */
export const ANCHOR_BUFFER_LIMIT = 500;

/**
 * B-805: live messages of a session whose latest page has not landed yet.
 *
 * The first one asks for that page ONCE per session per tab — the board's
 * previews and running-subagent counts read the messages this tab holds, so
 * sessions the user never opened still need them (Lead decision). Every later
 * one only joins the buffer: no second page request, no `after_seq`. When the
 * page lands it drains the buffer: entries the page already covers are echoes,
 * the rest apply and advance lastSeq through the contiguous run; a hole left
 * over is a real gap.
 *
 * `message: null` = decrypted but not renderable (the forward fetch drops it
 * too); its seq still counts as seen. An update dropped at the limit is not
 * recorded at all, so it surfaces as a gap instead of being skipped over.
 */
export class AnchorBuffer<M> {
    private buffers = new Map<string, Array<{ seq: number; message: M | null }>>();

    /** Records a live update; true when this is the session's first — the caller requests the page. */
    add(sessionId: string, seq: number, message: M | null): boolean {
        let buffer = this.buffers.get(sessionId);
        const first = !buffer;
        if (!buffer) {
            buffer = [];
            this.buffers.set(sessionId, buffer);
        }
        if (buffer.length < ANCHOR_BUFFER_LIMIT) buffer.push({ seq, message });
        return first;
    }

    /** The page request started: later updates join the buffer instead of asking again. */
    open(sessionId: string) {
        if (!this.buffers.has(sessionId)) this.buffers.set(sessionId, []);
    }

    /**
     * The page anchored lastSeq at `anchor`: what to apply (seq-ascending) and every seq seen past it.
     * `contiguous` (B-813 B1): only the run from anchor + 1 without a hole; the rest is dropped — the
     * anchor is older than the server's head (a cached run), so the forward fetch brings them in order.
     * `droppedMax` (B-819): the highest seq dropped that way (0 = none) — the forward fetch must reach
     * it, even when its first page was asked before these updates arrived.
     */
    drain(sessionId: string, anchor: number, options: { contiguous?: boolean } = {}): { messages: M[]; seqs: number[]; droppedMax: number } {
        const buffer = this.buffers.get(sessionId) ?? [];
        this.buffers.delete(sessionId);
        const sorted = buffer.filter((entry) => entry.seq > anchor).sort((a, b) => a.seq - b.seq);
        const after = options.contiguous ? contiguousRun(sorted, anchor) : sorted;
        const droppedMax = after.length < sorted.length ? sorted[sorted.length - 1].seq : 0;
        return {
            messages: after.flatMap((entry) => (entry.message ? [entry.message] : [])),
            seqs: after.map((entry) => entry.seq),
            droppedMax,
        };
    }

    clear(sessionId: string) {
        this.buffers.delete(sessionId);
    }
}

/** The leading entries of a seq-ascending list that continue `anchor` without a hole (a repeated seq is no hole). */
export function contiguousRun<E extends { seq: number }>(entries: readonly E[], anchor: number): E[] {
    let last = anchor;
    let end = 0;
    while (end < entries.length && entries[end].seq <= last + 1) {
        last = Math.max(last, entries[end].seq);
        end += 1;
    }
    return entries.slice(0, end);
}
