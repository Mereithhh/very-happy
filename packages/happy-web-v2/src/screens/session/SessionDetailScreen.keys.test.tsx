// @vitest-environment happy-dom
/**
 * Regression: the B-508 automation strip showed up twice (stacked, identical)
 * on veryhappy.dev c50066e1. Cause: B-585 mounted <WorktreeSetupBanner key={id}>
 * as a SIBLING of <AutomationAttentionBanner key={id}> in `.sd-main` — two
 * siblings with the same key. `.sd-main` children have `false` holes (branch
 * context, mirror banner, …), so every re-render reconciles via React's
 * key map; the second same-key fiber overwrites the first in that map, the
 * attention banner fiber is never deleted, and its DOM is left behind while a
 * fresh banner is inserted — one extra strip per screen re-render.
 * Same latent collision in `.sd-foot`: <PermissionCard key={id}> next to
 * <AgentInput key={composerKey(id)}> (== id once landed).
 *
 * Mounts the REAL screen with every child stubbed, re-renders it, and counts.
 */
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStore = vi.hoisted(() => {
    let session: any = null;
    const listeners = new Set<() => void>();
    return {
        get: () => session,
        set: (next: any) => { session = next; for (const l of listeners) l(); },
        subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
    };
});

vi.mock('@/sync/storage', () => {
    const state = { machines: {}, sessions: {}, currentViewingSessionId: null, setCurrentViewingSession: () => {} };
    const storage = Object.assign((selector: (s: any) => unknown) => selector(state), { getState: () => state });
    return {
        useSession: () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get),
        useMessage: () => null,
        useLocalSetting: () => false,
        useIsDataReady: () => false,
        storage,
    };
});
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: () => {} } }));
vi.mock('@/app/useKeyboardViewportPin', () => ({ useKeyboardViewportPin: () => {} }));
vi.mock('@/app/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/screens/files/useFilesPanelWidth', () => ({ useFilesPanelWidth: () => ({ width: 300, onHandleMouseDown: () => {} }) }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k, lang: 'en' }) }));
vi.mock('@/ui', () => ({ EmptyState: () => null, Button: () => null, OrbitLoader: () => null }));
vi.mock('@/sync/pendingSessionsRuntime', () => ({
    clearPendingSessionKeys: () => {},
    pendingDraft: () => '',
    pendingSessions: { aliasOf: () => undefined, isOwnedHere: () => true, markShown: () => {}, setViewing: () => {}, resume: async () => {}, append: () => {}, setMode: () => {}, get: () => undefined },
    usePendingRecord: () => undefined,
}));
vi.mock('../notes/notesPanelState', () => ({ setNotesPanelOpen: () => {} }));
vi.mock('../workspace/useRetainedWorkspace', () => ({ useRetainedWorkspace: () => null }));
vi.mock('./btwPanelState', () => ({ onBtwOpen: () => () => {} }));
vi.mock('./subagentPanelState', () => ({ onSubagentOpen: () => () => {} }));
vi.mock('./btwCommand', () => ({ canOfferBtw: () => false, supportsBtw: () => false }));
vi.mock('@/sync/btwStore', () => ({ btwStore: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/app/sessionRestore', () => ({ canOfferRestore: () => false }));
vi.mock('@/app/useHibernationAutoWake', () => ({ useHibernationAutoWake: () => {} }));
vi.mock('@/assistant/assistantSession', () => ({ isMirrorSession: () => false }));
vi.mock('@/app/newSessionTiming', () => ({ newSessionTimingComposerMounted: () => {}, newSessionTimingInStore: () => {}, newSessionTimingPendingShown: () => {} }));
vi.mock('./session.css', () => ({}));

vi.mock('./SessionPreviews', () => ({ SessionPreviews: () => null }));
vi.mock('./SubagentDock', () => ({ SubagentDock: () => null }));
vi.mock('./PermissionCard', () => ({ PermissionCard: () => <div data-testid="permission-card" /> }));
vi.mock('./SessionTeamContext', () => ({ SessionTeamContext: () => null }));
vi.mock('./ChatHeader', () => ({ ChatHeader: () => null }));
vi.mock('./ChatList', () => ({ ChatList: () => null }));
vi.mock('./AgentInput', () => ({ AgentInput: () => <div data-testid="agent-input" /> }));
vi.mock('./PendingSessionParts', () => ({ PendingSessionBody: () => null, PendingSessionHeader: () => null }));
vi.mock('./SessionWorkspacePanel', () => ({ SessionWorkspacePanel: () => null }));
vi.mock('../quickopen/QuickOpen', () => ({ QuickOpen: () => null }));
vi.mock('./MirrorBanner', () => ({ MirrorBanner: () => null }));
vi.mock('./MirrorInputBar', () => ({ MirrorInputBar: () => null }));
vi.mock('./SessionArchivedBanner', () => ({ SessionArchivedBanner: () => null }));
vi.mock('./StaleWrapperBanner', () => ({ StaleWrapperBanner: () => null }));
vi.mock('./ModelSupportBanner', () => ({ ModelSupportBanner: () => null }));
// Stateful like the real strip: its 「先收起」 hides it via local state (Owner 2026-10-13: neither
// duplicated strip could be closed — the orphaned copy's button updates a fiber React never renders).
vi.mock('./AutomationAttentionBanner', async () => {
    const React = await vi.importActual<typeof import('react')>('react');
    return {
        AutomationAttentionBanner: () => {
            const [hidden, setHidden] = React.useState(false);
            if (hidden) return null;
            return <div data-testid="automation-attention-banner"><button type="button" data-testid="banner-dismiss" onClick={() => setHidden(true)} /></div>;
        },
    };
});
// The worktree banner renders nothing for a non-worktree session — its fiber alone is enough to collide.
vi.mock('./WorktreeSetupBanner', () => ({ WorktreeSetupBanner: () => null }));

import { SessionDetailScreen } from './SessionDetailScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    sessionStore.set({ id: 's1', metadata: { machineId: 'm1', path: '/p' }, active: true });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const count = (testId: string) => host.querySelectorAll(`[data-testid="${testId}"]`).length;

describe('SessionDetailScreen sibling keys', () => {
    it('keeps exactly one automation strip (and one approval dock / composer) across re-renders', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => root.render(
            <MemoryRouter initialEntries={['/session/s1']}>
                <Routes><Route path="/session/:id" element={<SessionDetailScreen />} /></Routes>
            </MemoryRouter>,
        ));
        expect(count('automation-attention-banner')).toBe(1);
        // Ordinary session updates (activity, agent state, metadata) re-render the screen.
        for (let i = 0; i < 3; i++) {
            act(() => sessionStore.set({ ...sessionStore.get(), activeAt: i }));
            expect(count('automation-attention-banner')).toBe(1);
            expect(count('permission-card')).toBe(1);
            expect(count('agent-input')).toBe(1);
        }
        // Any same-key sibling pair (e.g. the approval dock next to the composer) is the same bug waiting for a hole.
        const dupKeys = errors.mock.calls.filter((args) => String(args[0]).includes('two children with the same key'));
        errors.mockRestore();
        expect(dupKeys).toEqual([]);
    });

    it('the strip can be dismissed after re-renders — no leftover copy that ignores its close button (B-594)', () => {
        act(() => root.render(
            <MemoryRouter initialEntries={['/session/s1']}>
                <Routes><Route path="/session/:id" element={<SessionDetailScreen />} /></Routes>
            </MemoryRouter>,
        ));
        for (let i = 0; i < 3; i++) act(() => sessionStore.set({ ...sessionStore.get(), activeAt: i }));
        for (const button of [...host.querySelectorAll<HTMLButtonElement>('[data-testid="banner-dismiss"]')]) act(() => button.click());
        expect(count('automation-attention-banner')).toBe(0);
        act(() => sessionStore.set({ ...sessionStore.get(), activeAt: 99 }));
        expect(count('automation-attention-banner')).toBe(0);
    });
});
