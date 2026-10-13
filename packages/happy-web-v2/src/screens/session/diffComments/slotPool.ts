/**
 * B-572 (review 低4): a fixed-size pool of "RPC in flight" slots.
 *
 * A released slot is HANDED to the next waiter instead of being freed, so a
 * caller arriving in between can never squeeze in as a (max+1)-th request.
 * A waiter whose work is no longer wanted (pane unmounted, newer reload)
 * cancels its ticket and is skipped without ever taking a slot.
 */
export type SlotTicket = { cancelled: boolean };

export function createSlotPool(max: number) {
    let inFlight = 0;
    const queue: Array<{ ticket: SlotTicket; grant: (ok: boolean) => void }> = [];
    const pool = {
        /** Resolves true with a slot held, or false if the ticket was cancelled while waiting. */
        acquire(ticket: SlotTicket): Promise<boolean> {
            if (ticket.cancelled) return Promise.resolve(false);
            if (inFlight < max) { inFlight++; return Promise.resolve(true); }
            return new Promise<boolean>((grant) => queue.push({ ticket, grant }));
        },
        /** Give the slot to the next live waiter, or free it. */
        release() {
            for (;;) {
                const next = queue.shift();
                if (!next) { inFlight--; return; }
                if (next.ticket.cancelled) { next.grant(false); continue; }
                next.grant(true);
                return;
            }
        },
        /** Drop a cancelled waiter now (so it settles without waiting for a release). */
        cancel(ticket: SlotTicket) {
            ticket.cancelled = true;
            const i = queue.findIndex((q) => q.ticket === ticket);
            if (i >= 0) queue.splice(i, 1)[0].grant(false);
        },
        get inFlight() { return inFlight; },
        get waiting() { return queue.length; },
    };
    return pool;
}
