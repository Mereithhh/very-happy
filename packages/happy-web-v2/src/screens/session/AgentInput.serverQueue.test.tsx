// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-509: with a wrapper that advertises `prompt-queue-v1`, a prompt typed
 * while the agent works goes to the SERVER queue (and is never released by
 * this tab); every other shape keeps the tab-local queue.
 */
const mocks = vi.hoisted(() => ({
    session: {
        draft: '  Queue me  ', presence: 'online', thinking: true,
        metadata: { flavor: 'claude', attachmentKinds: ['*/*'], capabilities: ['claude-steer-v1', 'prompt-queue-v1'] },
        agentState: { controlledByUser: false },
    },
    settings: { agentInputEnterToSend: true, agentDefaultOverrides: {} },
    working: true,
    gate: 'send' as 'send' | 'restore-first',
    queues: {} as Record<string, unknown>,
    queueState: { items: [] as Array<{ id: string; localId: string; position: number; text: string; modeMeta: object; createdAt: number }>, status: 'ready' as string },
    send: vi.fn(), paint: vi.fn(), restoreSession: vi.fn(), draft: vi.fn(), toast: vi.fn(), toastShow: vi.fn(), abort: vi.fn(), saveQueue: vi.fn(),
    enqueue: vi.fn(), load: vi.fn(), remove: vi.fn(), move: vi.fn(), updateText: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: mocks.abort, sessionSetPermissionMode: vi.fn() }));
vi.mock('@/sync/storage', () => ({
    useSession: () => mocks.session,
    useSessionUsage: () => null,
    useSetting: (key: keyof typeof mocks.settings) => mocks.settings[key],
    storage: { getState: () => ({ settings: mocks.settings, updateSessionDraft: mocks.draft }) },
}));
vi.mock('@/sync/persistence', () => ({ loadQueuedMessages: () => structuredClone(mocks.queues), saveQueuedMessages: mocks.saveQueue }));
vi.mock('@/sync/messageMeta', () => ({ resolveMessageModeMeta: () => ({ model: null, effort: 'high' }) }));
vi.mock('@/sync/suggestionCommands', () => ({ getAllCommands: () => [] }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/sync/agentLiveness', () => ({ isAgentWorkLive: () => mocks.working }));
vi.mock('@/app/sessionRestore', () => ({ composerGate: () => mocks.gate, restoreSession: mocks.restoreSession, useRestoreState: () => null }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', async () => ({ ...await vi.importActual<typeof import('@/ui/Spinner')>('@/ui/Spinner'), useToast: () => ({ error: mocks.toast, show: mocks.toastShow }) }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('./ModeMenu', () => ({ ModeMenu: () => null }));
vi.mock('./ModelEffortMenu', () => ({ ModelEffortMenu: () => null }));
vi.mock('./PresetsMenu', () => ({ PresetsMenu: () => null }));
vi.mock('./btwPanelState', () => ({ openBtwPanel: vi.fn() }));
vi.mock('./sendFeedback', () => ({ yieldForSendFeedback: mocks.paint }));
vi.mock('@/sync/promptQueue', async () => ({
    ...await vi.importActual<typeof import('@/sync/promptQueue')>('@/sync/promptQueue'),
    usePromptQueue: () => mocks.queueState,
    loadPromptQueue: mocks.load,
    enqueuePrompt: mocks.enqueue,
    removePrompt: mocks.remove,
    movePrompt: mocks.move,
    updatePromptText: mocks.updateText,
}));

import { AgentInput } from './AgentInput';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.session.draft = '  Queue me  ';
    mocks.session.metadata.capabilities = ['claude-steer-v1', 'prompt-queue-v1'];
    mocks.working = true;
    mocks.gate = 'send';
    mocks.queues = {};
    mocks.queueState = { items: [], status: 'ready' };
    mocks.saveQueue.mockImplementation(queues => { mocks.queues = structuredClone(queues); });
    mocks.paint.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue('queued');
    mocks.send.mockResolvedValue('accepted');
    mocks.remove.mockResolvedValue(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

function render() { act(() => root.render(<AgentInput sessionId="session" />)); }
function sendButton() { return host.querySelector<HTMLButtonElement>('.ci-send')!; }
async function clickSend() { await act(async () => { sendButton().click(); }); }
function localQueue() { return (mocks.queues as Record<string, unknown[]>).session ?? []; }

describe('AgentInput server-side prompt queue (B-509)', () => {
    it('a running-session send goes to the server queue, not the tab, and is not released by this tab', async () => {
        render();
        expect(mocks.load).toHaveBeenCalledWith('session');
        await clickSend();
        expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('session', 'Queue me', { model: null, effort: 'high' });
        expect(mocks.send).not.toHaveBeenCalled();
        expect(localQueue()).toEqual([]);
        expect(host.querySelector('.ci-queue-item')).toBeNull(); // the server snapshot renders it, not local state
        // Agent goes idle: the tab must NOT send anything — the wrapper pops the queue.
        mocks.working = false;
        await act(async () => root.render(<AgentInput sessionId="session" />));
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('renders the server snapshot as the queue with move/steer/delete wired to the server', async () => {
        mocks.queueState = {
            status: 'ready',
            items: [
                { id: 'q1', localId: 'l1', position: 1, text: 'first', modeMeta: { effort: 'low' }, createdAt: 1 },
                { id: 'q2', localId: 'l2', position: 2, text: 'second', modeMeta: {}, createdAt: 2 },
            ],
        };
        render();
        const items = host.querySelectorAll<HTMLElement>('.ci-queue-item');
        expect(items).toHaveLength(2);
        expect(host.querySelector('.ci-queue')!.getAttribute('data-queue-source')).toBe('server');
        expect(items[0].getAttribute('data-queue-item-source')).toBe('server');
        expect(items[0].querySelector('.ci-queue-text')!.textContent).toBe('first');
        // Steer: server delete first, then the live-turn send with the item's own mode meta.
        await act(async () => { items[0].querySelector<HTMLButtonElement>('.ci-queue-action--intervene')!.click(); });
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('session', 'q1');
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith('session', 'first', { source: 'chat', delivery: 'steer', modeMeta: { effort: 'low' } });
        // Already popped by the wrapper → no steer, user told.
        mocks.remove.mockResolvedValueOnce(false);
        await act(async () => { items[1].querySelector<HTMLButtonElement>('.ci-queue-action--intervene')!.click(); });
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledWith('session.chat.queueCancelTooLate');
        // Delete goes to the server.
        await act(async () => { items[1].querySelector<HTMLButtonElement>('[aria-label="session.chat.queueDelete"]')!.click(); });
        expect(mocks.remove).toHaveBeenLastCalledWith('session', 'q2');
        expect(localQueue()).toEqual([]);
    });

    it('an old server (unsupported) or an old wrapper (no capability) keeps the tab-local queue', async () => {
        mocks.queueState = { items: [], status: 'unsupported' };
        render();
        await clickSend();
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(localQueue()).toHaveLength(1);
        expect(host.querySelector('.ci-queue')!.getAttribute('data-queue-source')).toBe('local');

        act(() => root.unmount());
        root = createRoot(host);
        mocks.queues = {};
        mocks.queueState = { items: [], status: 'ready' };
        mocks.session.metadata.capabilities = ['claude-steer-v1'];
        render();
        await clickSend();
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(localQueue()).toHaveLength(1);
    });

    it('a server that answers 404 mid-send falls back to the tab-local queue for that item', async () => {
        mocks.enqueue.mockResolvedValueOnce('unsupported');
        render();
        await clickSend();
        expect(localQueue()).toHaveLength(1);
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('a failed enqueue keeps the draft and tells the user', async () => {
        mocks.enqueue.mockRejectedValueOnce(new Error('prompt_queue_full'));
        render();
        await clickSend();
        expect(mocks.toast).toHaveBeenCalledWith('session.chat.queueDeliveryFailed');
        expect(host.querySelector<HTMLTextAreaElement>('.ci-textarea')!.value).toBe('  Queue me  '); // exact failed draft, as every failed send
        expect(localQueue()).toEqual([]);
    });

    it('legacy tab-local text items migrate to the server once the queue is ready — and the idle gate never releases them from this tab', async () => {
        mocks.queues = { session: [{ id: 'old', text: 'left over', createdAt: 1, modeMeta: { model: null } }] };
        // Agent idle: before B-509 this tab would have released the item itself the
        // moment it mounted; with the server queue on it must migrate instead (else
        // the prompt runs twice: once from here, once when the wrapper pops it).
        mocks.working = false;
        render();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(mocks.send).not.toHaveBeenCalled();
        expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('session', 'left over', { model: null }, 'old');
        expect(localQueue()).toEqual([]);
    });

    it('B-509 review: idle + server items for 30 s = 「wrapper not picking it up」 with a send-now that removes the head from the server first', async () => {
        vi.useFakeTimers();
        try {
            mocks.working = false;
            mocks.queueState = { status: 'ready', items: [
                { id: 'q1', localId: 'l1', position: 1, text: 'stuck', modeMeta: { model: 'x' }, createdAt: 1 },
                { id: 'q2', localId: 'l2', position: 2, text: 'next', modeMeta: {}, createdAt: 2 },
            ] };
            render();
            expect(host.querySelector('[data-queue-stale]')).toBeNull();
            await act(async () => { vi.advanceTimersByTime(29_000); });
            expect(host.querySelector('[data-queue-stale]')).toBeNull();
            await act(async () => { vi.advanceTimersByTime(1_500); });
            expect(host.querySelector('[data-queue-stale]')).not.toBeNull();
            await act(async () => { host.querySelector<HTMLButtonElement>('[data-queue-stale] button')!.click(); });
            expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('session', 'q1');
            expect(mocks.send).toHaveBeenCalledExactlyOnceWith('session', 'stuck', { source: 'chat', delivery: 'queue', modeMeta: { model: 'x' } });
            // Working again → the notice goes away; it never shows while the agent runs.
            mocks.working = true;
            await act(async () => root.render(<AgentInput sessionId="session" />));
            expect(host.querySelector('[data-queue-stale]')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('B-509 review: Stop does not clear the server queue and says how many items will still run', async () => {
        mocks.queueState = { status: 'ready', items: [{ id: 'q1', localId: 'l1', position: 1, text: 'a', modeMeta: {}, createdAt: 1 }] };
        mocks.session.draft = '';
        mocks.abort.mockResolvedValue(undefined);
        render();
        await act(async () => { host.querySelector<HTMLButtonElement>('.ci-send--abort')!.click(); });
        await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 320)); });
        expect(mocks.abort).toHaveBeenCalledTimes(1);
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(mocks.toastShow).toHaveBeenCalledWith('session.chat.queueStillPending', 'info');
    });

    it('an archived session enqueues on the server and still asks for the restore', async () => {
        mocks.gate = 'restore-first';
        mocks.working = false;
        render();
        await clickSend();
        expect(mocks.enqueue).toHaveBeenCalledTimes(1);
        expect(mocks.restoreSession).toHaveBeenCalledExactlyOnceWith('session');
        expect(mocks.send).not.toHaveBeenCalled();
    });
});
