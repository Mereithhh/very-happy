/**
 * Owner 10-27 (「侧边栏的会话会突然变少」): every list the Web receives — a
 * /v1/sessions page, the B-823 changedSince re-reads, a single-row update —
 * is merged into the store; a batch never stands for "the whole set", so a
 * session missing from it keeps its sidebar row. Only deleteSession (a real
 * delete) removes one; archive is a field on the row (it moves to 归档).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { Session } from './storageTypes';

let storage: typeof import('./storage').storage;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('./storage'));
});

function session(id: string, patch: Partial<Session> = {}): Omit<Session, 'presence'> {
    const now = Date.now();
    return {
        id, seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
        metadata: { path: `/repo/${id}`, host: 'box', homeDir: '/home', happyHomeDir: '/h', happyLibDir: '/l', happyToolsDir: '/t' } as Session['metadata'],
        metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        ...patch,
    };
}
const listed = () => (storage.getState().sessionsData ?? []).filter((x): x is Session => typeof x !== 'string').map((x) => x.id).sort();

describe('applySessions merges, never replaces', () => {
    it('a later partial batch keeps every session it does not mention', () => {
        storage.getState().applySessions(['a', 'b', 'c', 'd'].map((id) => session(id)));
        expect(listed()).toEqual(['a', 'b', 'c', 'd']);

        // e.g. a list whose window no longer reaches a, b — or a 2-row catch-up.
        storage.getState().applySessions([session('c', { seq: 2 }), session('e')]);

        expect(listed()).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(storage.getState().sessions.c.seq).toBe(2);
    });

    it('only a real delete removes a row', () => {
        storage.getState().deleteSession('a');
        storage.getState().applySessions([session('b', { seq: 3 })]);
        expect(listed()).toEqual(['b', 'c', 'd', 'e']);
    });
});
