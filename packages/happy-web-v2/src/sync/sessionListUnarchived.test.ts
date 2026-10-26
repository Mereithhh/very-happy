/**
 * Owner 10-27 (「侧边栏的会话会突然变少，然后再加载回完整的 list」): the first
 * list is the 150 newest rows; once per page load the Web reads every
 * unarchived row (`scope=unarchived`) and merges it, and ready waits a bounded
 * time for it so a working link's first sidebar is the whole list.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedSinceCursor, mergeSessionListSnapshot, sessionListSnapshot } from './sessionListDelta';
import { sessionListRequest } from './sessionListPrefetch';

describe('scope=unarchived request', () => {
    it('the default list is unchanged; the unarchived read asks for scope=unarchived with the same headers', () => {
        const recent = sessionListRequest('https://x', 'tok');
        const unarchived = sessionListRequest('https://x', 'tok', 'unarchived');
        expect(recent.url).toBe('https://x/v1/sessions');
        expect(unarchived.url).toBe('https://x/v1/sessions?scope=unarchived');
        expect(unarchived.headers).toEqual(recent.headers);
    });
});

describe('mergeSessionListSnapshot', () => {
    it('adds the unarchived rows to the baseline without moving the catch-up cursor', () => {
        const base = sessionListSnapshot([{ id: 'a', updatedAt: 1_000_000 }, { id: 's', updatedAt: 5, share: {} }], 2_000_000);
        const merged = mergeSessionListSnapshot(base, [
            { id: 'old', updatedAt: 10 },
            { id: 'a', updatedAt: 900_000 }, // older copy: the known stamp stays
            { id: 'fresh', updatedAt: 3_000_000 }, // changed after the first list: still owned, cursor unmoved
            { id: 's2', updatedAt: 7, share: {} },
        ]);
        expect([...merged.owned]).toEqual([['a', 1_000_000], ['old', 10], ['fresh', 3_000_000]]);
        expect(merged.shared).toEqual(['s']);
        expect(changedSinceCursor(merged)).toBe(changedSinceCursor(base));
        expect(base.owned.has('old')).toBe(false);
    });
});

describe('sync.ts wiring', () => {
    const src = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');

    it('the first list starts the once-per-load unarchived read', () => {
        const fetchSessions = src.slice(src.indexOf('private fetchSessions = async'), src.indexOf('private fetchUnarchivedSessions = async'));
        expect(fetchSessions).toContain('if (!this.unarchivedSessionsList.settled) this.unarchivedSessionsSync.invalidate();');
    });

    it('the read merges through applySessions and settles the signal; it never runs twice in a load', () => {
        const body = src.slice(src.indexOf('private fetchUnarchivedSessions = async'), src.indexOf('private catchUpSessionsSinceList = async'));
        expect(body).toContain("if (!this.credentials || this.unarchivedSessionsList.settled) return;");
        expect(body).toContain("sessionListRequest(getServerUrl(), token, 'unarchived')");
        expect(body).toContain('this.applySessions(preserveSessionBatchActivityFromStore(decoded, storage.getState().sessions));');
        expect(body).toContain('const fresh = rowsToDecode(rows, storage.getState().sessions);\n        const decoded = await decodeSessionRows(this.encryption, fresh);');
        expect(body).toContain('this.unarchivedSessionsList.resolve();');
        // The response is "in" before any row is decoded: that is what ready waits for.
        expect(body.indexOf('this.unarchivedSessionsArrived.resolve();')).toBeGreaterThan(0);
        expect(body.indexOf('this.unarchivedSessionsArrived.resolve();')).toBeLessThan(body.indexOf('const decoded = await decodeSessionRows('));
    });

    it('ready waits for its response to arrive (not for its rows to be applied), bounded, after the first list', () => {
        expect(src).toContain('.then(() => settleWithin(unarchivedListArrived, UNARCHIVED_READY_WAIT_MS)).then(() => settleWithin(unarchivedListLoaded, UNARCHIVED_APPLY_WAIT_MS)).then(() => {\n            storage.getState().applyReady();');
        expect(src).toContain('const UNARCHIVED_APPLY_WAIT_MS = 300;');
        expect(src).toContain('const unarchivedListArrived = this.unarchivedSessionsArrived.promise;');
        expect(src).toContain('const UNARCHIVED_READY_WAIT_MS = 2_000;');
        expect(src).toContain('this.unarchivedSessionsArrived = deferredSignal();\n        const firstListLoaded');
    });
});
