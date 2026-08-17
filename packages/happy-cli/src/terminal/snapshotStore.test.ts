import { describe, it, expect } from 'vitest';
import { SnapshotStore, SNAPSHOT_PAGE_RAW_BYTES } from './snapshotStore';

const T0 = 1_700_000_000_000;
const mkStore = (pageBytes = 4) => {
    let n = 0;
    return new SnapshotStore({ pageBytes, graceMs: 10_000, ttlMs: 90_000, newId: () => `id${(n += 1)}` });
};
const collect = (store: SnapshotStore, terminalId: string, id: string, totalPages: number, now = T0) => {
    const parts: Buffer[] = [];
    for (let p = 0; p < totalPages; p++) {
        const r = store.getPage(terminalId, id, p, now);
        if ('expired' in r) throw new Error(`page ${p} expired`);
        parts.push(Buffer.from(r.data, 'base64'));
    }
    return Buffer.concat(parts);
};

describe('SnapshotStore paging', () => {
    it('pages a blob and reassembles it byte-exactly', () => {
        const store = mkStore(4);
        const blob = Buffer.from('0123456789abcde'); // 15 bytes → 4 pages
        const { snapshotId, totalPages } = store.put('t1', blob, T0);
        expect(totalPages).toBe(4);
        expect(collect(store, 't1', snapshotId, totalPages)).toEqual(blob);
    });

    it('is byte-exact for non-UTF-8 payloads', () => {
        const store = mkStore(3);
        const blob = Buffer.from([0xff, 0x00, 0x80, 0x1b, 0x5b, 0x41, 0xfe]);
        const h = store.put('t1', blob, T0);
        expect(collect(store, 't1', h.snapshotId, h.totalPages)).toEqual(blob);
    });

    it('an empty capture is a valid snapshot with zero pages (≠ expired)', () => {
        const store = mkStore();
        const h = store.put('t1', Buffer.alloc(0), T0);
        expect(h.totalPages).toBe(0);
        expect(store.getPage('t1', h.snapshotId, 0, T0)).toEqual({ expired: true });
    });

    it('the default page size stays inside the 256KB base64 budget', () => {
        expect(Math.ceil(SNAPSHOT_PAGE_RAW_BYTES / 3) * 4).toBeLessThanOrEqual(256 * 1024);
    });
});

describe('SnapshotStore lifecycle', () => {
    it('a new capture replaces the old one and invalidates its id immediately', () => {
        const store = mkStore();
        const first = store.put('t1', Buffer.from('aaaa'), T0);
        const second = store.put('t1', Buffer.from('bbbb'), T0 + 5);
        expect(store.getPage('t1', first.snapshotId, 0, T0 + 6)).toEqual({ expired: true });
        expect(store.getPage('t1', second.snapshotId, 0, T0 + 6)).toMatchObject({ page: 0 });
    });

    it('unknown terminal / unknown id / out-of-range page are all `expired`', () => {
        const store = mkStore();
        const h = store.put('t1', Buffer.from('aaaa'), T0);
        expect(store.getPage('other', h.snapshotId, 0, T0)).toEqual({ expired: true });
        expect(store.getPage('t1', 'bogus', 0, T0)).toEqual({ expired: true });
        expect(store.getPage('t1', h.snapshotId, 9, T0)).toEqual({ expired: true });
        expect(store.getPage('t1', h.snapshotId, -1, T0)).toEqual({ expired: true });
        expect(store.getPage('t1', h.snapshotId, 1.5, T0)).toEqual({ expired: true });
    });

    it('holds for the grace window after the last page (a lost page is retryable)', () => {
        const store = mkStore(4);
        const h = store.put('t1', Buffer.from('aaaabbbb'), T0); // 2 pages
        collect(store, 't1', h.snapshotId, 2, T0);
        store.sweep(T0 + 9_000);
        expect(store.getPage('t1', h.snapshotId, 1, T0 + 9_000)).toMatchObject({ page: 1 }); // retry works
        store.sweep(T0 + 9_000 + 10_001);
        expect(store.getPage('t1', h.snapshotId, 1, T0 + 20_000)).toEqual({ expired: true });
    });

    it('grace only starts at the LAST page — a half-pulled snapshot survives', () => {
        const store = mkStore(4);
        const h = store.put('t1', Buffer.from('aaaabbbbcccc'), T0); // 3 pages
        store.getPage('t1', h.snapshotId, 0, T0);
        store.sweep(T0 + 30_000);
        expect(store.getPage('t1', h.snapshotId, 1, T0 + 30_000)).toMatchObject({ page: 1 });
    });

    it('the absolute TTL bounds a client that walked away mid-pull', () => {
        const store = mkStore(4);
        const h = store.put('t1', Buffer.from('aaaabbbb'), T0);
        store.getPage('t1', h.snapshotId, 0, T0);
        store.sweep(T0 + 90_001);
        expect(store.getPage('t1', h.snapshotId, 0, T0 + 90_001)).toEqual({ expired: true });
        expect(store.size()).toBe(0);
    });

    it('drop() releases a dead terminal immediately', () => {
        const store = mkStore();
        const h = store.put('t1', Buffer.from('aaaa'), T0);
        store.drop('t1');
        expect(store.getPage('t1', h.snapshotId, 0, T0)).toEqual({ expired: true });
        expect(store.heldBytes()).toBe(0);
    });

    it('heldBytes reports the live memory the reaper bounds', () => {
        const store = mkStore();
        store.put('t1', Buffer.alloc(100), T0);
        store.put('t2', Buffer.alloc(50), T0);
        expect(store.heldBytes()).toBe(150);
        expect(store.size()).toBe(2);
    });
});
