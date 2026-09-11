// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    session: {
        draft: '  Send this draft  ', presence: 'online', thinking: false,
        metadata: { flavor: 'claude', attachmentKinds: ['*/*'], capabilities: ['claude-steer-v1'] },
        agentState: { controlledByUser: false },
    },
    settings: { agentInputEnterToSend: true, agentDefaultOverrides: {} },
    working: false,
    gate: 'send' as 'send' | 'restore-first',
    queues: {} as Record<string, unknown>,
    send: vi.fn(), paint: vi.fn(), restoreSession: vi.fn(), abort: vi.fn(), draft: vi.fn(),
    btw: vi.fn(), toast: vi.fn(), saveQueue: vi.fn(), modeMeta: vi.fn(),
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
vi.mock('@/sync/messageMeta', () => ({ resolveMessageModeMeta: mocks.modeMeta }));
vi.mock('@/sync/suggestionCommands', () => ({ getAllCommands: () => [] }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/sync/agentLiveness', () => ({ isAgentWorkLive: () => mocks.working }));
vi.mock('@/app/sessionRestore', () => ({
    composerGate: () => mocks.gate, restoreSession: mocks.restoreSession, useRestoreState: () => null,
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', async () => ({
    ...await vi.importActual<typeof import('@/ui/Spinner')>('@/ui/Spinner'),
    useToast: () => ({ error: mocks.toast }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('./ModeMenu', () => ({ ModeMenu: () => null }));
vi.mock('./ModelEffortMenu', () => ({ ModelEffortMenu: () => null }));
vi.mock('./PresetsMenu', () => ({ PresetsMenu: () => null }));
vi.mock('./btwPanelState', () => ({ openBtwPanel: mocks.btw }));
vi.mock('./sendFeedback', () => ({ yieldForSendFeedback: mocks.paint }));

import { AgentInput } from './AgentInput';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((yes, no) => { resolve = () => yes('accepted-message'); reject = no; });
    return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let paint: ReturnType<typeof deferred>;
let request: ReturnType<typeof deferred>;
let revoke: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.session.draft = '  Send this draft  ';
    mocks.working = false;
    mocks.gate = 'send';
    mocks.queues = {};
    mocks.saveQueue.mockImplementation(queues => { mocks.queues = structuredClone(queues); });
    mocks.modeMeta.mockReset().mockReturnValue({ model: null, effort: null });
    paint = deferred();
    request = deferred();
    mocks.paint.mockReturnValue(paint.promise);
    mocks.send.mockReturnValue(request.promise);
    mocks.restoreSession.mockResolvedValue(undefined);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => `blob:${(blob as File).name}`);
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

function render() { act(() => root.render(<AgentInput sessionId="session" />)); }
function input() { return host.querySelector<HTMLTextAreaElement>('.ci-textarea')!; }
function sendButton() { return host.querySelector<HTMLButtonElement>('.ci-send')!; }
async function clickSend() { await act(async () => { sendButton().click(); }); }
async function enter(options: KeyboardEventInit = {}) {
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options })); });
}
function changeDraft(value: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function attach(name: string) {
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['file data'], name, { type: 'text/plain' })] });
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function finishPaint() { await act(async () => { paint.resolve(); }); }

describe('AgentInput immediate send feedback', () => {
    it('commits the real spinner before preflight or relay work and locks same-frame repeated events', async () => {
        render();
        await act(async () => {
            input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            sendButton().click();
        });
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        expect(sendButton().disabled).toBe(true);
        expect(sendButton().querySelector('.vh-spinner')).not.toBeNull();
        expect(input().value).toBe('');
        expect(mocks.paint).toHaveBeenCalledTimes(1);
        expect(mocks.modeMeta).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        await finishPaint();
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith('session', 'Send this draft', {
            source: 'chat', delivery: 'queue', attachments: undefined, modeMeta: { model: null, effort: null },
        });
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        await act(async () => { request.resolve(); });
        expect(sendButton().getAttribute('aria-busy')).toBe('false');
        expect(sendButton().querySelector('.vh-spinner')).toBeNull();
        expect(input().value).toBe('');
    });

    it('restores failed text and attachments without overwriting the next draft or revoking its files', async () => {
        render();
        await attach('first.txt');
        await clickSend();
        expect(host.querySelectorAll('.ci-att')).toHaveLength(0);
        changeDraft('Next draft');
        await attach('next.txt');
        mocks.draft.mockClear();
        await finishPaint();
        expect(mocks.draft).not.toHaveBeenCalled();
        expect(mocks.send.mock.calls[0][2].attachments.map((file: { name: string }) => file.name)).toEqual(['first.txt']);
        await act(async () => { request.reject(new Error('relay failed')); });
        expect(input().value).toBe('  Send this draft  \nNext draft');
        expect([...host.querySelectorAll('.ci-att-file')].map(file => file.textContent)).toEqual(['first.txt', 'next.txt']);
        expect(revoke).not.toHaveBeenCalled();
        expect(sendButton().getAttribute('aria-busy')).toBe('false');
        expect(sendButton().disabled).toBe(false);
    });

    it('restores an attachment-only request on preflight failure and allows retry', async () => {
        mocks.session.draft = '';
        mocks.modeMeta.mockImplementationOnce(() => { throw new Error('preflight failed'); });
        render();
        await attach('only.txt');
        await clickSend();
        await finishPaint();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(input().value).toBe('');
        expect(host.querySelector('.ci-att-file')?.textContent).toBe('only.txt');
        expect(sendButton().disabled).toBe(false);
        expect(sendButton().getAttribute('aria-busy')).toBe('false');
        expect(revoke).not.toHaveBeenCalled();
        await clickSend();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        await act(async () => { request.resolve(); });
        expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:only.txt');
    });

    it('keeps a running-session send in the queue and releases it through the existing idle gate', async () => {
        mocks.working = true;
        render();
        await clickSend();
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        expect(host.querySelectorAll('.ci-queue-item')).toHaveLength(1);
        await finishPaint();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(host.querySelectorAll('.ci-queue-item')).toHaveLength(1);
        expect(sendButton().classList.contains('ci-send--abort')).toBe(true);
        mocks.working = false;
        await act(async () => root.render(<AgentInput sessionId="session" />));
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send.mock.calls[0][2].delivery).toBe('queue');
        await act(async () => { request.resolve(); });
    });

    it('paints before archived-session restore and holds its message until the session can receive it', async () => {
        mocks.gate = 'restore-first';
        render();
        await clickSend();
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        expect(mocks.restoreSession).not.toHaveBeenCalled();
        await finishPaint();
        expect(mocks.restoreSession).toHaveBeenCalledExactlyOnceWith('session');
        expect(mocks.send).not.toHaveBeenCalled();
        expect(host.querySelectorAll('.ci-queue-item')).toHaveLength(1);
        expect(sendButton().getAttribute('aria-busy')).toBe('false');
        mocks.gate = 'send';
        await act(async () => root.render(<AgentInput sessionId="session" />));
        expect(mocks.send).toHaveBeenCalledTimes(1);
        await act(async () => { request.resolve(); });
    });

    it('preserves explicit steer and never routes it through Stop or the local queue', async () => {
        mocks.working = true;
        render();
        await enter({ metaKey: true });
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        await finishPaint();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send.mock.calls[0][2].delivery).toBe('steer');
        expect(host.querySelector('.ci-queue-item')).toBeNull();
        expect(mocks.abort).not.toHaveBeenCalled();
        await act(async () => { request.resolve(); });
    });

    it.each(['queue', 'restore'] as const)('retains an accepted %s submission when unmounted before feedback paints', async (path) => {
        mocks.working = path === 'queue';
        mocks.gate = path === 'restore' ? 'restore-first' : 'send';
        render();
        await clickSend();
        expect(mocks.queues.session).toEqual([expect.objectContaining({ text: 'Send this draft' })]);
        act(() => root.render(null));
        expect(mocks.draft).toHaveBeenLastCalledWith('session', null);
        await finishPaint();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(mocks.restoreSession).toHaveBeenCalledTimes(path === 'restore' ? 1 : 0);
        expect(mocks.queues.session).toEqual([expect.objectContaining({ text: 'Send this draft' })]);
        mocks.session.draft = '';
        render();
        expect(host.querySelectorAll('.ci-queue-item')).toHaveLength(1);
        mocks.working = false;
        mocks.gate = 'send';
        await act(async () => root.render(<AgentInput sessionId="session" />));
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send.mock.calls[0][1]).toBe('Send this draft');
        await act(async () => { request.resolve(); });
    });

    it('does not auto-release a pre-enqueued submission when the agent becomes idle before the feedback frame', async () => {
        mocks.working = true;
        render();
        await clickSend();
        mocks.working = false;
        await act(async () => root.render(<AgentInput sessionId="session" />));
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        expect(mocks.send).not.toHaveBeenCalled();
        await finishPaint();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        await act(async () => { request.resolve(); });
    });

    it('does not clear a remounted composer draft when the previous submission reaches its frame', async () => {
        mocks.working = true;
        render();
        await clickSend();
        act(() => root.render(null));
        mocks.session.draft = 'New draft after returning';
        render();
        mocks.draft.mockClear();
        await finishPaint();
        expect(input().value).toBe('New draft after returning');
        expect(mocks.draft).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('ignores Enter while a real attachment is still processing instead of sending an incomplete payload', async () => {
        let pendingImage!: HTMLImageElement;
        vi.spyOn(window, 'Image').mockImplementation(() => {
            pendingImage = document.createElement('img');
            return pendingImage;
        });
        render();
        const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['image'], 'pending.png', { type: 'image/png' })] });
        await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(sendButton().getAttribute('aria-busy')).toBe('true');
        await enter();
        expect(input().value).toBe('  Send this draft  ');
        expect(mocks.paint).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        await act(async () => { pendingImage.dispatchEvent(new Event('load')); });
        expect(host.querySelectorAll('.ci-att')).toHaveLength(1);
        expect(sendButton().disabled).toBe(false);
    });

    it('keeps /btw as an immediate local command and leaves its attachments in the composer', async () => {
        mocks.session.draft = '/btw explain this';
        render();
        await attach('kept.txt');
        await clickSend();
        expect(mocks.btw).toHaveBeenCalledExactlyOnceWith('session', 'explain this');
        expect(mocks.send).not.toHaveBeenCalled();
        expect(mocks.paint).not.toHaveBeenCalled();
        expect(input().value).toBe('');
        expect(host.querySelector('.ci-att-file')?.textContent).toBe('kept.txt');
        expect(revoke).not.toHaveBeenCalled();
    });
});
