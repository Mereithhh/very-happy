import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    catchUpSessionList,
    CHANGED_SINCE_SKEW_MS,
    changedSinceCursor,
    DATE_SLACK_MS,
    MAX_DELTA_READS,
    parseServedAt,
    planSessionCatchUp,
    sessionListSnapshot,
} from './sessionListDelta';

/** A tiny server: owned rows with Prisma-style `updatedAt`, plus rows shared with us. */
type Row = { id: string; updatedAt: number; metadataVersion: number; archivedAt: number | null; share?: { grantId: string } };
function server(rows: Row[]) {
    const owned = new Map(rows.filter((r) => !r.share).map((r) => [r.id, { ...r }]));
    const shared = new Map(rows.filter((r) => r.share).map((r) => [r.id, { ...r }]));
    return {
        owned,
        shared,
        /** A write the socket would have pushed — lost because the tab was not in the room yet. */
        write(id: string, at: number, patch: Partial<Row> = {}) {
            const target = owned.get(id) ?? shared.get(id);
            if (target) Object.assign(target, { metadataVersion: target.metadataVersion + 1 }, patch, { updatedAt: at });
            else owned.set(id, { id, updatedAt: at, metadataVersion: 1, archivedAt: null, ...patch });
        },
        list: () => [...owned.values(), ...shared.values()].map((r) => ({ ...r })),
        // GET /v2/sessions?changedSince= — owner rows only, like the route.
        listChanged: vi.fn(async (changedSince: number) => ({
            rows: [...owned.values()].filter((r) => r.updatedAt > changedSince).map((r) => ({ id: r.id, updatedAt: r.updatedAt })),
            hasNext: false,
        })),
        readRows: vi.fn(async (ids: readonly string[]) => ids.flatMap((id) => {
            const row = owned.get(id) ?? shared.get(id);
            return row ? [{ ...row }] : [];
        })),
    };
}

const T = 1_800_000_000_000;

describe('B-823 first-connect session list catch-up (QA9 P2-3)', () => {
    it('re-reads exactly what changed in the window — no second full list', async () => {
        const s = server([
            { id: 'a', updatedAt: T - 5_000, metadataVersion: 3, archivedAt: null },
            { id: 'b', updatedAt: T - 90_000, metadataVersion: 1, archivedAt: null },
            { id: 'c', updatedAt: T - 400_000, metadataVersion: 7, archivedAt: null },
        ]);
        const snapshot = sessionListSnapshot(s.list()); // the first GET
        // The window: between the snapshot and joining the room.
        s.write('b', T + 1_000, { archivedAt: T + 1_000 }); // archived elsewhere
        s.write('new', T + 1_500); // a session created meanwhile
        const applied: Row[] = [];
        const fullList = vi.fn();
        const outcome = await catchUpSessionList({ snapshot, listChanged: s.listChanged, readRows: s.readRows, apply: (rows) => { applied.push(...rows); }, fullList });

        expect(fullList).not.toHaveBeenCalled();
        expect(s.listChanged).toHaveBeenCalledWith(T - 5_000 - CHANGED_SINCE_SKEW_MS);
        // `a` is inside the skew margin but unchanged: listed, not re-read.
        expect(s.readRows).toHaveBeenCalledWith(['b', 'new']);
        expect(applied.map((r) => [r.id, r.archivedAt, r.metadataVersion])).toEqual([['b', T + 1_000, 2], ['new', null, 1]]);
        expect(outcome).toEqual({ kind: 'rows', changed: 3, reread: 2 });
    });

    it('a write stamped before the newest row but committed after the snapshot is still caught (skew margin)', async () => {
        const s = server([
            { id: 'a', updatedAt: T, metadataVersion: 1, archivedAt: null },
            { id: 'slow', updatedAt: T - 10_000, metadataVersion: 1, archivedAt: null },
        ]);
        const snapshot = sessionListSnapshot(s.list());
        // A transaction that stamped updatedAt at T-2s and committed after the snapshot read.
        s.write('slow', T - 2_000);
        const readRows = s.readRows;
        await catchUpSessionList({ snapshot, listChanged: s.listChanged, readRows, apply: () => {}, fullList: vi.fn() });
        expect(readRows).toHaveBeenCalledWith(['slow']);
    });

    it('rows shared with this account are always re-read (the v2 list is owner-scoped)', async () => {
        const s = server([
            { id: 'mine', updatedAt: T, metadataVersion: 1, archivedAt: null },
            { id: 'theirs', updatedAt: T - 1, metadataVersion: 4, archivedAt: null, share: { grantId: 'g1' } },
        ]);
        const snapshot = sessionListSnapshot(s.list());
        expect(snapshot.shared).toEqual(['theirs']);
        expect(snapshot.owned.has('theirs')).toBe(false);
        s.write('theirs', T + 500);
        const applied: Row[] = [];
        await catchUpSessionList({ snapshot, listChanged: s.listChanged, readRows: s.readRows, apply: (rows) => { applied.push(...rows); }, fullList: vi.fn() });
        expect(applied.map((r) => [r.id, r.metadataVersion])).toEqual([['theirs', 5]]);
    });

    it('nothing changed: one small list read, nothing re-read, nothing applied', async () => {
        const s = server([{ id: 'a', updatedAt: T, metadataVersion: 1, archivedAt: null }]);
        const apply = vi.fn();
        const fullList = vi.fn();
        const outcome = await catchUpSessionList({ snapshot: sessionListSnapshot(s.list()), listChanged: s.listChanged, readRows: s.readRows, apply, fullList });
        expect(outcome).toEqual({ kind: 'rows', changed: 1, reread: 0 });
        expect(s.readRows).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
        expect(fullList).not.toHaveBeenCalled();
    });

    it('falls back to the full list: no baseline, a next page, too many changes, any failure', async () => {
        const fullList = vi.fn();
        const base = { readRows: vi.fn(async () => []), apply: vi.fn() };
        const snapshot = sessionListSnapshot([{ id: 'a', updatedAt: T }]);

        expect(await catchUpSessionList({ ...base, snapshot: null, listChanged: vi.fn(), fullList })).toEqual({ kind: 'full', reason: 'no-baseline' });
        expect(await catchUpSessionList({ ...base, snapshot, listChanged: async () => ({ rows: [], hasNext: true }), fullList })).toEqual({ kind: 'full', reason: 'more-pages' });
        const many = Array.from({ length: MAX_DELTA_READS + 1 }, (_, i) => ({ id: `n${i}`, updatedAt: T + i }));
        expect(await catchUpSessionList({ ...base, snapshot, listChanged: async () => ({ rows: many, hasNext: false }), fullList })).toEqual({ kind: 'full', reason: 'too-many' });
        expect(await catchUpSessionList({ ...base, snapshot, listChanged: async () => { throw new Error('404'); }, fullList })).toEqual({ kind: 'full', reason: 'failed' });
        const changedOne = async () => ({ rows: [{ id: 'a', updatedAt: T + 1 }], hasNext: false });
        expect(await catchUpSessionList({ ...base, snapshot, listChanged: changedOne, readRows: async () => { throw new Error('timeout'); }, fullList })).toEqual({ kind: 'full', reason: 'failed' });
        expect(await catchUpSessionList({ ...base, snapshot, listChanged: changedOne, readRows: async () => [{}], apply: () => { throw new Error('decode'); }, fullList })).toEqual({ kind: 'full', reason: 'failed' });
        expect(fullList).toHaveBeenCalledTimes(6);
        expect(base.apply).not.toHaveBeenCalled();
    });

    it('with the list response\'s Date the cursor is just before the snapshot — rows changed long before it are not even listed', async () => {
        const s = server([
            { id: 'a', updatedAt: T - 20_000, metadataVersion: 1, archivedAt: null },
            { id: 'b', updatedAt: T - 30_000, metadataVersion: 1, archivedAt: null },
        ]);
        const servedAt = parseServedAt(new Date(T + 4_000).toUTCString()); // whole seconds, after the read
        const snapshot = sessionListSnapshot(s.list(), servedAt);
        s.write('b', T + 6_000);
        const outcome = await catchUpSessionList({ snapshot, listChanged: s.listChanged, readRows: s.readRows, apply: () => {}, fullList: vi.fn() });
        const cursor = s.listChanged.mock.calls[0][0];
        expect(cursor).toBe(Math.floor(servedAt! - DATE_SLACK_MS));
        expect(cursor).toBeGreaterThan(T - 20_000); // `a` (unchanged) is no longer in the reply
        expect(outcome).toEqual({ kind: 'rows', changed: 1, reread: 1 });
        // A stamp taken before the read but committed after it is still past the cursor.
        expect(T + 4_000 - 1_000 - 9_000).toBeGreaterThanOrEqual(cursor);
        // An unreadable / malformed header falls back to the rows' bound.
        expect(parseServedAt(null)).toBeNull();
        expect(parseServedAt('garbage')).toBeNull();
        expect(changedSinceCursor(sessionListSnapshot(s.list(), null))).toBe(T + 6_000 - CHANGED_SINCE_SKEW_MS);
        // A stale Date (older than the rows) never loosens the bound below the rows' one.
        expect(changedSinceCursor(sessionListSnapshot(s.list(), T - 600_000))).toBe(T + 6_000 - CHANGED_SINCE_SKEW_MS);
    });

    it('the planner: exactly MAX_DELTA_READS still re-reads; the cursor stays a positive integer', () => {
        const snapshot = sessionListSnapshot([]);
        expect(changedSinceCursor(snapshot)).toBe(1);
        expect(changedSinceCursor(sessionListSnapshot([{ id: 'a', updatedAt: T + 0.5 }]))).toBe(T - CHANGED_SINCE_SKEW_MS);
        const rows = Array.from({ length: MAX_DELTA_READS }, (_, i) => ({ id: `n${i}`, updatedAt: T }));
        expect(planSessionCatchUp(snapshot, rows, false)).toEqual({ kind: 'rows', ids: rows.map((r) => r.id) });
    });
});

describe('B-823 wiring in sync.ts', () => {
    const sync = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');
    const body = (start: string, end: string) => sync.slice(sync.indexOf(start), sync.indexOf(end, sync.indexOf(start)));

    it('the first connect runs the catch-up; every later connect re-reads the full list', () => {
        const reconnected = body('apiSocket.onReconnected(', 'this.machinesSync.invalidate();');
        expect(reconnected).toContain('const firstConnect = !this.socketConnectedOnce;\n            this.socketConnectedOnce = true;\n            if (firstConnect) {\n                this.sessionsCatchUpSync.invalidate();\n            } else {\n                this.sessionsSync.invalidate();\n            }');
        // The viewed session: a reconnect aborts a possibly stuck catch-up; the first connect coalesces behind the boot's page.
        expect(body('apiSocket.onReconnected(', 'apiSocket.onRecovered(')).toContain('this.catchUpViewedSession({ restart: !firstConnect });');
        expect(body('private catchUpViewedSession(', 'private trackMessagesCatchUp(')).toContain('this.onSessionEnter(viewing, { restartFetch: opts.restart });');
        // Recovered reconnects keep their full list (spec §C).
        expect(body('apiSocket.onRecovered(', 'private handleRelayCommittedMessages')).toContain('this.sessionsSync.invalidate();');
    });

    it('the baseline is the full list just applied; the catch-up waits for that list first', () => {
        expect(body('private fetchSessions = async', 'private catchUpSessionsSinceList')).toContain('this.applySessions(mergedSessions);\n        this.sessionListSnapshot = sessionListSnapshot(sessions, parseServedAt(date));');
        // The Date header travels with the body, from the prefetch and from a regular attempt alike.
        expect(body('private fetchSessions = async', 'private catchUpSessionsSinceList')).toContain("return { data: await response.json(), date: response.headers.get('date') };");
        const catchUp = body('private catchUpSessionsSinceList = async', 'private async readChangedSessions');
        expect(catchUp).toContain('await this.sessionsSync.awaitQueue();\n        await catchUpSessionList({\n            snapshot: this.sessionListSnapshot,');
        expect(catchUp).toContain('fullList: () => this.sessionsSync.invalidate(),');
        expect(catchUp).toContain('this.applySessions(preserveSessionBatchActivityFromStore(decoded, storage.getState().sessions));');
    });

    it('the catch-up reads are bounded and re-read the list projection by id', () => {
        const reads = body('private async readChangedSessions', '     * B-798 P1-8: one session by id.');
        expect(reads).toContain('/v2/sessions?changedSince=${changedSince}&limit=${DELTA_PAGE_LIMIT}');
        expect(reads).toContain('/v1/sessions/${encodeURIComponent(id)}');
        expect(reads.match(/timeoutMs: SYNC_READ_TIMEOUT_MS,/g)).toHaveLength(2);
        expect(reads).toContain('if (response.status === 404) continue;');
    });
});
