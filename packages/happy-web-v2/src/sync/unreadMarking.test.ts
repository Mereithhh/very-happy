import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let storage: typeof import('./storage').storage;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('./storage'));
});

const NOW = 1_700_000_000_000;

function session(overrides: Record<string, unknown> = {}) {
    return {
        id: 's1',
        seq: 1,
        createdAt: NOW,
        updatedAt: NOW,
        active: true,
        activeAt: NOW,
        metadata: { machineId: 'm1', path: '/repo', flavor: 'claude' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        ...overrides,
    } as never;
}

describe('unread marking (B-312)', () => {
    beforeEach(() => {
        storage.setState({ sessions: {}, unreadSessionIds: new Set(), currentViewingSessionId: null } as never);
    });

    it('marks a session that finished a turn while the user was elsewhere', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(false);
        storage.getState().applySessions([session({ thinking: false, updatedAt: NOW + 1000 })]);
        expect([...storage.getState().unreadSessionIds]).toEqual(['s1']);
    });

    it('does NOT mark the session the user is currently looking at', () => {
        storage.setState({ currentViewingSessionId: 's1' } as never);
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(false);
    });

    it('surfaces the flag on the row data the sidebar renders', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, updatedAt: NOW + 1000 })]);
        const rows = storage.getState().sessionListViewData ?? [];
        const flat = rows.flatMap((r: any) => r.type === 'session' ? [r.session] : r.type === 'active-sessions' ? r.sessions : []);
        expect(flat.find((s: any) => s.id === 's1')?.hasUnread).toBe(true);
    });
});

describe('unread marking — the cases that produce NO dot', () => {
    beforeEach(() => {
        storage.setState({ sessions: {}, unreadSessionIds: new Set(), currentViewingSessionId: null } as never);
    });

    it('a session that goes offline in the same update is never marked', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, active: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(false);
    });

    it('a session marked while online keeps the flag after it goes offline', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(true);
        storage.getState().applySessions([session({ thinking: false, active: false, updatedAt: NOW + 2000 })]);
        // The flag survives — but Sidebar gates the dot on `session.active`,
        // so the row shows nothing once the wrapper is gone.
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(true);
        expect(storage.getState().sessions['s1'].presence).not.toBe('online');
    });
});
