/**
 * B-616: a session's history loads on demand only — the newest page (extended
 * to the newest turn's opener, bounded) on open, then one page per request
 * from the reader. No background loop, no other caller of loadOlderMessages
 * inside sync itself.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    HISTORY_PAGE_SIZE,
    INITIAL_TURN_START_PAGES,
    shouldExtendInitialWindow,
    windowHasTurnStart,
} from './historyWindow';
import type { NormalizedMessage } from './typesRaw';

const user = (id: string, isSidechain = false): NormalizedMessage => ({
    role: 'user',
    content: { type: 'text', text: `q ${id}` },
    id,
    localId: null,
    createdAt: 1,
    isSidechain,
} as NormalizedMessage);
const agent = (id: string): NormalizedMessage => ({
    role: 'agent',
    content: [{ type: 'text', text: `a ${id}`, uuid: id, parentUUID: null }],
    id,
    localId: null,
    createdAt: 1,
    isSidechain: false,
} as NormalizedMessage);

describe('windowHasTurnStart', () => {
    it('is true once the window holds a user prompt', () => {
        expect(windowHasTurnStart([agent('a1'), user('u1'), agent('a2')])).toBe(true);
    });
    it('a window of agent output only (the middle of a long tool run) has no turn start', () => {
        expect(windowHasTurnStart([agent('a1'), agent('a2')])).toBe(false);
        expect(windowHasTurnStart([])).toBe(false);
    });
    it('a sub-agent sidechain prompt does not open a turn', () => {
        expect(windowHasTurnStart([agent('a1'), user('side', true)])).toBe(false);
    });
});

describe('shouldExtendInitialWindow', () => {
    it('stops at a turn start', () => {
        expect(shouldExtendInitialWindow({ hasMore: true, hasTurnStart: true, extraPagesFetched: 0 })).toBe(false);
    });
    it('stops when the server has nothing older', () => {
        expect(shouldExtendInitialWindow({ hasMore: false, hasTurnStart: false, extraPagesFetched: 0 })).toBe(false);
    });
    it('fetches at most INITIAL_TURN_START_PAGES extra pages for a turn that never starts', () => {
        expect(INITIAL_TURN_START_PAGES).toBe(2);
        expect(shouldExtendInitialWindow({ hasMore: true, hasTurnStart: false, extraPagesFetched: 0 })).toBe(true);
        expect(shouldExtendInitialWindow({ hasMore: true, hasTurnStart: false, extraPagesFetched: 1 })).toBe(true);
        expect(shouldExtendInitialWindow({ hasMore: true, hasTurnStart: false, extraPagesFetched: 2 })).toBe(false);
    });
});

describe('sync fetches history on demand only (B-616)', () => {
    const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');

    it('has no background prefetch loop', () => {
        expect(source).not.toContain('prefetchOlderMessagesInBackground');
        expect(source).not.toContain('SLEEP_BETWEEN_PAGES');
    });

    it('never calls loadOlderMessages itself — only the reader does (ChatList, ChatPromptRail)', () => {
        expect(source.match(/this\.loadOlderMessages\(/g)).toBeNull();
    });

    it('pages every history request with the shared page size', () => {
        expect(HISTORY_PAGE_SIZE).toBe(100);
        expect(source).not.toMatch(/limit=100\b/);
        expect(source).toContain('&limit=${HISTORY_PAGE_SIZE}');
    });

    it('the initial window is extended to a turn start and applied as one batch', () => {
        const initial = source.slice(source.indexOf('private fetchInitialLatestPage'), source.indexOf('private fetchForwardSince'));
        expect(initial).toContain('shouldExtendInitialWindow({ hasMore, hasTurnStart: windowHasTurnStart(itemMessages(window)), extraPagesFetched })');
        // B-812: one merge (the latest-page source) for the whole window.
        expect(initial.match(/this\.mergeSessionMessages\(/g)).toHaveLength(1);
        expect(initial).toContain("this.mergeSessionMessages(sessionId, window, 'latest-page');");
    });
});
