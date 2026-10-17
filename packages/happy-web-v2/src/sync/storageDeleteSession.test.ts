/**
 * B-619 regression: deleteSession must purge the session from the lane the
 * sidebar renders (`sessionsData` via useSessions), not only from `sessions` /
 * `sessionListViewData`. Before the fix an un-shared (or deleted) session kept
 * its sidebar row until the next /v1/sessions refetch.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { Session } from './storageTypes';

let storage: typeof import('./storage').storage;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('./storage'));
});

function session(id: string, share?: Session['share']): Omit<Session, 'presence'> {
    const now = Date.now();
    return {
        id, seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
        metadata: { path: '/repo', host: 'box', homeDir: '/home', happyHomeDir: '/h', happyLibDir: '/l', happyToolsDir: '/t' } as Session['metadata'],
        metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        ...(share ? { share } : {}),
    };
}

describe('deleteSession purges the sidebar list lane', () => {
    it('removes the row from sessionsData and keeps the other rows', () => {
        storage.getState().applySessions([
            session('keep-me'),
            session('shared-gone', { grantId: 'g1', role: 'viewer', owner: { id: 'o', displayName: 'Owner' } }),
        ]);
        const before = (storage.getState().sessionsData ?? []).filter((x): x is Session => typeof x !== 'string').map((x) => x.id);
        expect(before).toEqual(expect.arrayContaining(['keep-me', 'shared-gone']));

        storage.getState().deleteSession('shared-gone');

        const after = (storage.getState().sessionsData ?? []).filter((x): x is Session => typeof x !== 'string').map((x) => x.id);
        expect(after).toContain('keep-me');
        expect(after).not.toContain('shared-gone');
        expect(storage.getState().sessions['shared-gone']).toBeUndefined();
    });
});
