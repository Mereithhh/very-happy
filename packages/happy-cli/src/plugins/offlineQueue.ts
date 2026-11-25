/**
 * B-974c: writes made while the daemon cannot reach the server (DESIGN §5.1
 * 离线行为). Per install at most 200 entries; one entry per key (badge,
 * decision:<key>, widget:<sessionId>), the newest write wins, replayed in order.
 */

export const OFFLINE_QUEUE_LIMIT = 200;

export type QueuedOp = { key: string; op: string; payload: Record<string, unknown>; queuedAt: number };

/** Combine a queued write with a newer one for the same key. */
export function mergeQueued(older: QueuedOp, newer: QueuedOp): QueuedOp {
    // A partial update on top of a queued create/update keeps the create.
    if (newer.op === 'decision.patch' && (older.op === 'decision.post' || older.op === 'decision.patch')) {
        const { key: _k, ...patch } = newer.payload;
        return { ...older, payload: { ...older.payload, ...patch }, queuedAt: newer.queuedAt };
    }
    return newer;
}

export class OfflineQueue {
    private queues = new Map<string, QueuedOp[]>();

    constructor(private readonly persist?: (installId: string, items: QueuedOp[]) => void, readonly limit = OFFLINE_QUEUE_LIMIT) {}

    load(installId: string, items: QueuedOp[]): void {
        this.queues.set(installId, items.slice(-this.limit));
    }

    size(installId: string): number { return this.queues.get(installId)?.length ?? 0; }
    has(installId: string, key: string): boolean { return (this.queues.get(installId) ?? []).some((i) => i.key === key); }
    items(installId: string): QueuedOp[] { return [...(this.queues.get(installId) ?? [])]; }
    installIds(): string[] { return [...this.queues.keys()].filter((id) => this.size(id) > 0); }

    /** false = the install already has `limit` other keys queued. */
    enqueue(installId: string, item: QueuedOp): boolean {
        const list = this.queues.get(installId) ?? [];
        const at = list.findIndex((i) => i.key === item.key);
        let next: QueuedOp[];
        if (at >= 0) {
            const merged = mergeQueued(list[at], item);
            next = [...list.slice(0, at), ...list.slice(at + 1), merged];
        } else {
            if (list.length >= this.limit) return false;
            next = [...list, item];
        }
        this.queues.set(installId, next);
        this.persist?.(installId, next);
        return true;
    }

    clear(installId: string): void {
        this.queues.delete(installId);
        this.persist?.(installId, []);
    }

    /**
     * Replay in order. `send` returns 'sent' (done, or refused for good —
     * dropped either way) or 'offline' (stop; the rest stays queued).
     */
    async drain(installId: string, send: (item: QueuedOp) => Promise<'sent' | 'offline'>): Promise<number> {
        let sent = 0;
        for (;;) {
            const list = this.queues.get(installId) ?? [];
            const head = list[0];
            if (!head) break;
            const outcome = await send(head);
            if (outcome === 'offline') break;
            // Drop the head only if it was not replaced while in flight.
            const now = this.queues.get(installId) ?? [];
            const rest = now[0] === head ? now.slice(1) : now.filter((i) => i !== head);
            this.queues.set(installId, rest);
            this.persist?.(installId, rest);
            sent++;
        }
        return sent;
    }
}
