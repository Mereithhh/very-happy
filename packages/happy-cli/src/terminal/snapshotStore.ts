/**
 * B-121 terminal channel v2 — the paged history snapshot store (daemon side).
 *
 * A lines-mode `open` answers immediately with a SHALLOW screen (300-line
 * class, inline in the RPC result) and hands out a `snapshotId` for the deep
 * history, which the web then pulls page by page over `terminal-history`. This
 * module owns the blob between those two steps.
 *
 * Why a store at all — the alternative was rejected in review: capturing again
 * when the first history page is requested would take the capture at a DIFFERENT
 * point in time than the small snapshot, so the rebuilt screen would contain
 * duplicated (and out-of-order) scrollback. The capture happens exactly ONCE per
 * open/catch-up, and every page is served from that one blob.
 *
 * Lifecycle rules (spec D1 「snapshotId hold 生命周期」):
 *  - a new capture for the same terminal REPLACES the old snapshot, and the old
 *    id is invalid immediately (its assembly is stale by definition);
 *  - after the LAST page is delivered the blob is held for a grace period
 *    instead of being dropped — a page lost in flight must be retryable without
 *    redoing the whole open;
 *  - an absolute TTL bounds everything else (a client that walks away mid-pull);
 *  - a request for an unknown/expired id is answered `expired`, which the web
 *    treats as "keep the shallow screen, retry the open once" — never a silent
 *    hang.
 *
 * Memory: one blob per LIVE terminal, each bounded by the capture budget
 * (1MB) — the same bound the reaper already enforces on live terminals.
 *
 * No timers: `sweep(now)` is driven by the manager's existing reaper tick, so
 * this module stays a pure, unit-testable state machine.
 */

/** Raw bytes per page. base64 inflates by 4/3 → 240KB on the wire, inside the
 *  256KB budget that keeps the encrypted RPC envelope well under the server's
 *  1e6 socket.io message limit (measured margin 2.9×). */
export const SNAPSHOT_PAGE_RAW_BYTES = 180 * 1024;

/** Hold after the last page is delivered (retry window for a lost page). */
export const SNAPSHOT_GRACE_MS = 10_000;

/** Absolute lifetime of a snapshot, delivered or not. */
export const SNAPSHOT_TTL_MS = 90_000;

export interface SnapshotHandle {
    snapshotId: string;
    totalPages: number;
}

export interface SnapshotPage {
    page: number;
    totalPages: number;
    /** base64 of this page's raw bytes. */
    data: string;
}

export type SnapshotPageResult = SnapshotPage | { expired: true };

interface HeldSnapshot {
    id: string;
    blob: Buffer;
    totalPages: number;
    createdAt: number;
    /** Set when the last page has been handed out — starts the grace window. */
    lastPageAt?: number;
}

export interface SnapshotStoreOptions {
    pageBytes?: number;
    graceMs?: number;
    ttlMs?: number;
    /** Injectable id source so tests are deterministic. */
    newId?: () => string;
}

export class SnapshotStore {
    private readonly held = new Map<string, HeldSnapshot>();
    private readonly pageBytes: number;
    private readonly graceMs: number;
    private readonly ttlMs: number;
    private readonly newId: () => string;
    private counter = 0;

    constructor(opts: SnapshotStoreOptions = {}) {
        this.pageBytes = Math.max(1, opts.pageBytes ?? SNAPSHOT_PAGE_RAW_BYTES);
        this.graceMs = opts.graceMs ?? SNAPSHOT_GRACE_MS;
        this.ttlMs = opts.ttlMs ?? SNAPSHOT_TTL_MS;
        this.newId = opts.newId ?? (() => `s${Date.now().toString(36)}${(this.counter += 1).toString(36)}`);
    }

    /**
     * Hold one freshly captured blob for a terminal, replacing (and thereby
     * invalidating) whatever that terminal held before. An empty blob still
     * gets an id with totalPages 0 — the web must be able to tell "no deep
     * history" apart from "the id you have is stale".
     */
    put(terminalId: string, blob: Buffer, now: number = Date.now()): SnapshotHandle {
        const totalPages = Math.ceil(blob.length / this.pageBytes);
        const id = this.newId();
        this.held.set(terminalId, { id, blob, totalPages, createdAt: now });
        return { snapshotId: id, totalPages };
    }

    /**
     * Serve one page (0-based). Anything that doesn't match the terminal's
     * CURRENT snapshot — wrong id, swept, out-of-range page — is `expired`, so
     * the client has exactly one failure mode to handle.
     */
    getPage(terminalId: string, snapshotId: string, page: number, now: number = Date.now()): SnapshotPageResult {
        const held = this.held.get(terminalId);
        if (!held || held.id !== snapshotId) return { expired: true };
        if (!Number.isInteger(page) || page < 0 || page >= held.totalPages) return { expired: true };
        const start = page * this.pageBytes;
        const data = held.blob.subarray(start, start + this.pageBytes).toString('base64');
        if (page === held.totalPages - 1) held.lastPageAt = now;
        return { page, totalPages: held.totalPages, data };
    }

    /** Drop a terminal's snapshot outright (terminal died / was killed). */
    drop(terminalId: string): void {
        this.held.delete(terminalId);
    }

    /** Expire by grace window and TTL. Driven by the manager's reaper tick. */
    sweep(now: number = Date.now()): void {
        for (const [terminalId, held] of [...this.held]) {
            const expired = now - held.createdAt > this.ttlMs
                || (held.lastPageAt !== undefined && now - held.lastPageAt > this.graceMs);
            if (expired) this.held.delete(terminalId);
        }
    }

    /** Total bytes currently held — the manager logs/bounds against this. */
    heldBytes(): number {
        let total = 0;
        for (const held of this.held.values()) total += held.blob.length;
        return total;
    }

    /** Test/diagnostic view. */
    size(): number {
        return this.held.size;
    }
}
