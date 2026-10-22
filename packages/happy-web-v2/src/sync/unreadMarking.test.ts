import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { showsUnreadDot } from './unreadTransition';
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

describe('unread marking — runs that end offline (B-331)', () => {
    beforeEach(() => {
        storage.setState({ sessions: {}, unreadSessionIds: new Set(), currentViewingSessionId: null } as never);
    });

    it('a session that finishes and goes offline in the same update IS marked', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, active: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().sessions['s1'].presence).not.toBe('online');
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(true);
    });

    it('a wrapper that exits mid-turn (thinking never cleared) is marked too', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: true, active: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(true);
    });

    it('still not marked while the user is looking at it', () => {
        storage.setState({ currentViewingSessionId: 's1' } as never);
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, active: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(false);
    });

    it('an idle session going offline (hibernate, daemon restart) is not marked', () => {
        storage.getState().applySessions([session({ thinking: false })]);
        storage.getState().applySessions([session({ thinking: false, active: false, updatedAt: NOW + 1000 })]);
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(false);
    });

    it('the dot shows on an offline row and hides only once the user archives it', () => {
        storage.getState().applySessions([session({ thinking: true })]);
        storage.getState().applySessions([session({ thinking: false, active: false, updatedAt: NOW + 1000 })]);
        const ids = storage.getState().unreadSessionIds;
        const offline = storage.getState().sessions['s1'];
        expect(offline.active).toBe(false);
        expect(showsUnreadDot({ ...offline, archivedAt: null }, ids)).toBe(true);
        expect(showsUnreadDot({ ...offline, archivedAt: undefined }, ids)).toBe(true);
        expect(showsUnreadDot({ ...offline, archivedAt: NOW + 2000 }, ids)).toBe(false);
        expect(showsUnreadDot(undefined, ids)).toBe(false);
    });
});

describe('Sidebar paints the dot through showsUnreadDot, not session.active (B-331)', () => {
    const src = readFileSync(new URL('../screens/sessions/Sidebar.tsx', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    it('the row signal, the folded-group summary and the tree badges (B-762) all use it', () => {
        expect(src.match(/r\.kind === 'session' &&\s*showsUnreadDot\(r\.session, unreadIds\)/g)).toHaveLength(3);
        expect(src).not.toMatch(/!!r\.session\?\.active\s*&&\s*unreadIds\.has/);
    });
});
