/**
 * B-806: the inbound cursor (`lastSeq`) means "every message up to here was
 * routed or deliberately skipped". A POST ack only proves OUR messages exist,
 * so jumping the cursor to the ack's max seq would skip a Web message stored in
 * between (Web's central fallback took seq N, our output N+1, our ack beat N's
 * update — or the socket was down): the next catch-up fetch starts after N+1
 * and N is never routed. Same rule as the Web's B-513 `advanceLastSeq`.
 *
 * `handled` holds seqs this client already accounted for (its own committed
 * output, relay-delivered input it routed itself). The cursor only moves
 * through a contiguous run of them; whatever remains above it is a gap that a
 * fetch must fill. Entries at or below the result are dropped from `handled`.
 */
export function advanceInboundCursor(current: number, handled: Set<number>): { next: number; gap: boolean } {
    let next = current;
    while (handled.has(next + 1)) {
        next += 1;
    }
    for (const seq of handled) {
        if (seq <= next) handled.delete(seq);
    }
    return { next, gap: handled.size > 0 };
}
