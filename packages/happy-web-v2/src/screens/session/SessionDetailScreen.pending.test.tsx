// @vitest-environment happy-dom
// B-516: the pending page renders in SessionDetailScreen's single tree, keeps
// the composer mounted from the pending id to its own real id, and only the
// page still showing that pending id redirects.
import { act, useEffect, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/sync/ops';

const h = vi.hoisted(() => {
    const sessions: Record<string, { id: string; metadata: Record<string, unknown> }> = {};
    const listeners = new Set<() => void>();
    return {
        sessions,
        listeners,
        emit: () => listeners.forEach((l) => l()),
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        setViewing: vi.fn(), visible: vi.fn(), clearKeys: vi.fn(), sent: [] as string[],
        composer: { mounts: 0, unmounts: 0, props: [] as Array<{ sessionId: string; pending?: unknown; agentFlavor?: string }> },
        spawn: null as null | ((r: SpawnSessionResult) => void),
        table: [] as unknown[],
        dataReady: false,
        lookup: vi.fn<(id: string) => Promise<'found' | 'missing'>>(),
        drafts: {} as Record<string, string>,
        stash: vi.fn(),
    };
});

vi.mock('@/sync/useLauncherModelSource', () => ({ useLauncherModelSource: () => ({ context: null, catalogs: [] }) }));
vi.mock('@/sync/storage', () => {
    const state = () => ({
        sessions: h.sessions, machines: {}, currentViewingSessionId: null,
        setCurrentViewingSession: h.setViewing,
    });
    const storage = Object.assign(
        (selector: (s: ReturnType<typeof state>) => unknown) => useSyncExternalStore(h.subscribe, () => selector(state())),
        { getState: state, subscribe: h.subscribe },
    );
    return {
        storage,
        useSession: (id: string) => useSyncExternalStore(h.subscribe, () => h.sessions[id] ?? null),
        useMessage: () => null,
        useLocalSetting: () => false,
        useIsDataReady: () => useSyncExternalStore(h.subscribe, () => h.dataReady),
    };
});
vi.mock('@/sync/sync', () => ({ sync: { onSessionEnter: h.visible, fetchSessionById: h.lookup } }));
vi.mock('@/app/BackButton', () => ({ BackButton: () => <button data-back /> }));
vi.mock('@/sync/pendingSessionsRuntime', async () => {
    const core = await vi.importActual<typeof import('@/sync/pendingSessions')>('@/sync/pendingSessions');
    let n = 0;
    const pendingSessions = core.createPendingSessionStore({
        tabId: 'tab', isOwnerAlive: async (owner) => owner === 'other-tab', withClaimLock: (fn) => fn(),
        migrateDraft: () => {}, killSession: () => {},
        spawn: () => new Promise<SpawnSessionResult>((resolve) => { h.spawn = resolve; }),
        hasSession: (id) => !!h.sessions[id],
        subscribeSessions: h.subscribe,
        sendMessage: async (_id, text) => { h.sent.push(text); return 'receipt'; },
        writePermissionMode: () => {}, writeModelMode: () => {}, writeEffortLevel: () => {},
        restoreText: () => {}, clearKeys: () => {}, readDraft: (id) => h.drafts[id] ?? '', stashNewChatDraft: (text) => h.stash(text), takeNewChatDraft: () => '', writeDraft: () => {}, onSpawned: () => {}, notifyFailure: () => {},
        load: () => structuredClone(h.table), save: (records) => { h.table = structuredClone(records); }, now: () => 1, newId: () => `n${++n}`, sessionWaitMs: 60_000,
    });
    return {
        pendingSessions,
        clearPendingSessionKeys: h.clearKeys,
        pendingDraft: () => '',
        usePendingRecord: (routeId: string | undefined) =>
            useSyncExternalStore(pendingSessions.subscribe, () => pendingSessions.forRoute(routeId)),
    };
});
vi.mock('./AgentInput', () => ({
    AgentInput: (props: { sessionId: string; pending?: unknown; agentFlavor?: string }) => {
        h.composer.props.push(props);
        useEffect(() => { h.composer.mounts++; return () => { h.composer.unmounts++; }; }, []);
        return <div data-composer={props.sessionId} data-pending-composer={props.pending ? 'yes' : 'no'} />;
    },
}));
vi.mock('./PendingSessionParts', () => ({
    PendingSessionHeader: ({ record }: { record: { state: string } }) => <header data-pending-header={record.state} />,
    PendingSessionBody: ({ record }: { record: { outbox: unknown[] } }) => <div data-pending-body={record.outbox.length} />,
}));
vi.mock('./ChatHeader', () => ({ ChatHeader: ({ sessionId }: { sessionId: string }) => <header data-chat-header={sessionId} /> }));
vi.mock('./ChatList', () => ({ ChatList: ({ sessionId }: { sessionId: string }) => <div data-chat-list={sessionId} /> }));
vi.mock('./SessionPreviews', () => ({ SessionPreviews: () => null }));
vi.mock('./SubagentDock', () => ({ SubagentDock: () => null }));
vi.mock('./SessionTeamContext', () => ({ SessionTeamContext: () => null }));
vi.mock('./SessionWorkspacePanel', () => ({ SessionWorkspacePanel: () => null }));
vi.mock('./MirrorBanner', () => ({ MirrorBanner: () => null }));
vi.mock('./MirrorInputBar', () => ({ MirrorInputBar: () => null }));
vi.mock('./SessionArchivedBanner', () => ({ SessionArchivedBanner: () => null }));
vi.mock('./StaleWrapperBanner', () => ({ StaleWrapperBanner: () => null }));
vi.mock('./ModelSupportBanner', () => ({ ModelSupportBanner: () => null }));
vi.mock('./AutomationAttentionBanner', () => ({ AutomationAttentionBanner: () => null }));
vi.mock('./WorktreeSetupBanner', () => ({ WorktreeSetupBanner: () => null }));
vi.mock('./messageActionsCopy', () => ({ messageActionsCopy: () => ({}) }));
vi.mock('./btwPanelState', () => ({ onBtwOpen: () => () => {} }));
vi.mock('./subagentPanelState', () => ({ onSubagentOpen: () => () => {} }));
vi.mock('./btwCommand', () => ({ canOfferBtw: () => false, supportsBtw: () => false }));
vi.mock('@/sync/btwStore', () => ({ btwStore: { getState: () => ({ sessions: {} }) } }));
vi.mock('../notes/notesPanelState', () => ({ setNotesPanelOpen: vi.fn() }));
vi.mock('@/app/useKeyboardViewportPin', () => ({ useKeyboardViewportPin: () => {} }));
vi.mock('@/app/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/screens/files/useFilesPanelWidth', () => ({ useFilesPanelWidth: () => ({ width: 300, onHandleMouseDown: () => {} }) }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({
    EmptyState: ({ title, actions }: { title: string; actions?: unknown }) => <div data-empty={title}>{actions as never}</div>,
    Button: (p: { children?: unknown; onClick?: () => void }) => <button data-action={p.children as string} onClick={p.onClick}>{p.children as string}</button>,
    OrbitLoader: () => <div data-loader />,
}));
vi.mock('@/app/sessionRestore', () => ({ canOfferRestore: () => false }));
// B-587: the auto-wake hook reads the restore store; a pending page never wakes anything.
vi.mock('@/app/useHibernationAutoWake', () => ({ useHibernationAutoWake: () => {} }));
vi.mock('@/assistant/assistantSession', () => ({ isMirrorSession: () => false }));

import { SessionDetailScreen } from './SessionDetailScreen';
import { pendingSessions } from '@/sync/pendingSessionsRuntime';

let host: HTMLDivElement;
let root: Root;
let nav: NavigateFunction;
let where = '';
function Probe() {
    nav = useNavigate();
    const location = useLocation();
    where = `${location.pathname}${location.search}`;
    return null;
}
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };

function renderAt(path: string) {
    act(() => root.render(
        <MemoryRouter initialEntries={[path]}>
            <Probe />
            <Routes>
                <Route path="/session/:id" element={<SessionDetailScreen />} />
            </Routes>
        </MemoryRouter>,
    ));
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    for (const key of Object.keys(h.sessions)) delete h.sessions[key];
    h.sent.length = 0;
    h.dataReady = false;
    h.composer = { mounts: 0, unmounts: 0, props: [] };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('SessionDetailScreen pending page (B-516)', () => {
    it('B-801: leaving a draft page drops the draft and stashes its text; a remount keeps it', async () => {
        h.spawn = null;
        const record = pendingSessions.create({ machineId: 'm', path: '/repo', agent: 'claude', permissionMode: null, source: 'quick', draft: true });
        h.drafts[record.pendingId] = 'half typed';
        h.sessions.elsewhere = { id: 'elsewhere', metadata: {} };
        renderAt(`/session/${record.pendingId}`);
        await flush();
        expect(host.querySelector('[data-pending-header="draft"]')).not.toBeNull();
        // StrictMode-style remount of the same page: still there
        renderAt(`/session/${record.pendingId}`);
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(pendingSessions.get(record.pendingId)).toBeDefined();
        await act(async () => { nav('/session/elsewhere'); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(pendingSessions.get(record.pendingId)).toBeUndefined();
        expect(h.stash).toHaveBeenCalledWith('half typed');
        expect(h.spawn).toBeNull();
        // back to the left draft's URL: the same draft again, not 「已不存在」
        await act(async () => { nav(-1); });
        await flush();
        expect(pendingSessions.get(record.pendingId)?.state).toBe('draft');
        expect(host.querySelector('[data-pending-header="draft"]')).not.toBeNull();
        expect(host.querySelector('[data-empty]')).toBeNull();
    });

    it('renders the pending layout at once, skips viewing-session calls, and lands without remounting the composer', async () => {
        const record = pendingSessions.create({ machineId: 'm', path: '/repo', agent: 'codex', permissionMode: 'default', source: 'quick', firstMessage: 'hi' });
        const shown = vi.fn();
        void pendingSessions.waitShown(record.pendingId, 60_000).then(shown);
        renderAt(`/session/${record.pendingId}?panel=x`);
        await flush();
        expect(host.querySelector('[data-pending-header="spawning"]')).not.toBeNull();
        expect(host.querySelector('[data-pending-body="1"]')).not.toBeNull();
        expect(host.querySelector('[data-chat-list]')).toBeNull();
        expect(host.querySelector(`[data-composer="${record.pendingId}"][data-pending-composer="yes"]`)).not.toBeNull();
        expect(h.composer.props.at(-1)?.agentFlavor).toBe('codex');
        expect(shown).toHaveBeenCalled(); // global new-chat lock released
        expect(h.setViewing).not.toHaveBeenCalled();
        expect(h.visible).not.toHaveBeenCalled();

        // spawn succeeds; the session reaches the store; the outbox flushes
        await act(async () => { h.spawn!({ type: 'success', sessionId: 'real1' }); });
        await flush();
        // still pending until the session exists: composer not switched yet
        expect(host.querySelector(`[data-composer="${record.pendingId}"]`)).not.toBeNull();
        await act(async () => { h.sessions.real1 = { id: 'real1', metadata: {} }; h.emit(); });
        await flush();
        expect(h.sent).toEqual(['hi']);
        expect(host.querySelector('[data-composer="real1"][data-pending-composer="no"]')).not.toBeNull();
        expect(host.querySelector('[data-chat-list="real1"]')).not.toBeNull();
        expect(h.composer.mounts).toBe(1);
        expect(h.composer.unmounts).toBe(0);
        expect(where).toBe('/session/real1?panel=x'); // replace, search kept
        expect(h.clearKeys).toHaveBeenCalledWith(record.pendingId);
        expect(h.setViewing).toHaveBeenCalledWith('real1');

        // any other session change remounts
        await act(async () => { h.sessions.other = { id: 'other', metadata: {} }; h.emit(); });
        await act(async () => { nav('/session/other'); });
        expect(h.composer.mounts).toBe(2);
        expect(h.composer.unmounts).toBe(1);
    });

    it('never pulls a user who left back to the landed session', async () => {
        const record = pendingSessions.create({ machineId: 'm', path: '/repo', agent: 'claude', permissionMode: null, source: 'quick' });
        h.sessions.elsewhere = { id: 'elsewhere', metadata: {} };
        renderAt(`/session/${record.pendingId}`);
        await flush();
        await act(async () => { nav('/session/elsewhere'); });
        await act(async () => { h.sessions.real2 = { id: 'real2', metadata: {} }; h.spawn!({ type: 'success', sessionId: 'real2' }); });
        await flush();
        expect(pendingSessions.get(record.pendingId)?.state).toBe('landed');
        expect(where).toBe('/session/elsewhere');
    });

    it('a spawning page owned by another tab refuses sends without clearing the composer (e2e regression)', async () => {
        h.table = [...h.table, {
            pendingId: 'pending-foreign', ownerTab: 'other-tab', machineId: 'm', path: '/repo', agent: 'claude',
            permissionMode: null, source: 'quick', createdAt: 1, state: 'spawning', outbox: [{ id: 'o1', text: 'from A' }],
        }];
        act(() => pendingSessions.refresh());
        renderAt('/session/pending-foreign');
        await flush();
        const props = h.composer.props.at(-1) as { pending?: { onSend(t: string): boolean; blockedHint?: string } };
        expect(props.pending).toBeDefined();
        expect(props.pending!.blockedHint).toBe('pendingSession.otherTab');
        // refused → AgentInput keeps the text (AgentInput.pending.test.tsx) and says why
        expect(props.pending!.onSend('from B')).toBe(false);
        expect(pendingSessions.get('pending-foreign')?.outbox.map((o) => o.text)).toEqual(['from A']);
    });

    it('shows a gone state for a pending id without a record', async () => {
        renderAt('/session/pending-unknown');
        await flush();
        expect(host.querySelector('[data-empty="pendingSession.goneTitle"]')).not.toBeNull();
        expect(host.querySelector('[data-composer]')).toBeNull();
    });
});

// B-798 P1-8: an id the loaded list lacks is looked up; only the server's 404 ends the spinner.
describe('SessionDetailScreen unknown id (B-798 P1-8)', () => {
    it('waits for the list, then shows 「会话不存在」 on a 404 with the shared back control', async () => {
        h.lookup.mockResolvedValue('missing');
        renderAt('/session/doesnotexist');
        await flush();
        expect(h.lookup).not.toHaveBeenCalled();
        expect(host.querySelector('[data-loader]')).not.toBeNull();
        await act(async () => { h.dataReady = true; h.emit(); });
        await flush();
        expect(h.lookup).toHaveBeenCalledTimes(1);
        expect(h.lookup).toHaveBeenCalledWith('doesnotexist');
        expect(host.querySelector('[data-empty="session.notFoundTitle"]')).not.toBeNull();
        expect(host.querySelector('[data-loader]')).toBeNull();
        expect(host.querySelector('[data-back]')).not.toBeNull();
        expect(host.textContent).not.toContain('Session doesnotexist');
    });

    it('an old session outside the list window loads instead of spinning', async () => {
        h.dataReady = true;
        h.lookup.mockImplementation(async (id) => { h.sessions[id] = { id, metadata: {} }; h.emit(); return 'found'; });
        renderAt('/session/old1');
        await flush();
        expect(host.querySelector('[data-chat-list="old1"]')).not.toBeNull();
    });

    it('a failed lookup offers a retry that asks again', async () => {
        h.dataReady = true;
        h.lookup.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('missing');
        renderAt('/session/x1');
        await flush();
        expect(host.querySelector('[data-empty="session.loadFailedTitle"]')).not.toBeNull();
        expect(host.querySelector('[data-loader]')).toBeNull();
        await act(async () => { (host.querySelector('[data-action="common.retry"]') as HTMLButtonElement).click(); });
        await flush();
        expect(h.lookup).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[data-empty="session.notFoundTitle"]')).not.toBeNull();
    });
});
