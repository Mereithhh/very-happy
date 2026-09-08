import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { createRewindBranch } from '@/screens/session/rewindOperation';
import { resolveMessageModeMeta } from './messageMeta';
import type { Session } from './storageTypes';
let storage: typeof import('./storage').storage;
let loadSessionDrafts: typeof import('./persistence').loadSessionDrafts;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('./storage'));
    ({ loadSessionDrafts } = await import('./persistence'));
});
const snapshot = (id: string) => ({ id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0, metadata: { path: '/repo' }, metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false } as Session);
describe('branch drafts before snapshot hydration', () => {
    it('keeps parent read-only on the first message despite global yolo defaults', async () => {
        const id = await createRewindBranch({ source: { kind: 'codex', sessionId: 'parent', machineId: 'machine', directory: '/repo', codexThreadId: 'thread' }, pointId: 'item' }, 'read-only', {
            rpc: async () => ({ type: 'success', startFresh: true }),
            spawn: async () => ({ type: 'success', sessionId: 'read-only-branch' }),
            rememberMode: (id, mode) => storage.getState().updateSessionPermissionMode(id, mode),
        });
        storage.getState().applySessions([{ ...snapshot(id), metadata: { ...snapshot(id).metadata!, flavor: 'codex' } }]);
        expect(resolveMessageModeMeta(storage.getState().sessions[id], { agentDefaultOverrides: { codex: { permissionMode: 'yolo' } } }).permissionMode).toBe('read-only');
    });
    it('retains an unknown branch draft while another composer saves, then hydrates it', () => {
        storage.getState().applySessions([snapshot('existing-draft')]);
        storage.getState().updateSessionDraft('new-branch', 'edited B');
        storage.getState().updateSessionDraft('existing-draft', 'another draft');
        expect(loadSessionDrafts()['new-branch']).toBe('edited B');
        storage.getState().applySessions([snapshot('new-branch')]);
        expect(storage.getState().sessions['new-branch'].draft).toBe('edited B');
        storage.getState().updateSessionDraft('new-branch', null);
        storage.getState().applySessions([snapshot('new-branch')]);
        expect(storage.getState().sessions['new-branch'].draft).toBeNull();
        expect(loadSessionDrafts()['new-branch']).toBeUndefined();
        expect(loadSessionDrafts()['existing-draft']).toBe('another draft');
    });
});
