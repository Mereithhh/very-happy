// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';

const mocks = vi.hoisted(() => ({
    state: { sessions: {} as Record<string, Session>, updateSessionDraft: vi.fn(), updateSessionModelMode: vi.fn(), updateSessionEffortLevel: vi.fn(), updateSessionPermissionMode: vi.fn() },
    rpc: vi.fn(), create: vi.fn(), send: vi.fn(), refresh: vi.fn(), navigate: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({ storage: Object.assign((selector: (s: typeof mocks.state) => unknown) => selector(mocks.state), { getState: () => mocks.state }) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { machineRPC: mocks.rpc } }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send, refreshSessions: mocks.refresh } }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: vi.fn() }));
vi.mock('@/sync/heartbeatLease', () => ({ isHeartbeatFresh: () => true }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('@/ui/Toast', () => ({ toast: { success: vi.fn() } }));
vi.mock('./rewindOperation', () => ({ createRewindBranch: mocks.create }));
import { MessageActions } from './MessageActions';

let host: HTMLDivElement;
let root: Root;
const message = { kind: 'user-text', id: 'msg', localId: null, seq: 1, text: 'original', createdAt: 1, claudeUuid: 'point' } satisfies UserTextMessage;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.state.sessions = { parent: { id: 'parent', thinking: false, metadata: { machineId: 'machine', path: '/repo', flavor: 'claude', claudeSessionId: 'source' } } as Session };
    mocks.rpc.mockResolvedValue({ type: 'success', points: [{ uuid: 'point', text: 'original', timestamp: 1 }] });
    mocks.create.mockResolvedValue('branch');
    mocks.refresh.mockImplementation(async () => { mocks.state.sessions.branch = { id: 'branch' } as Session; });
    mocks.send.mockResolvedValue({ id: 'receipt' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(userMessage: UserTextMessage = message) {
    act(() => root.render(<MessageActions text="original" sessionId="parent" userMessage={userMessage}><div className="original-bubble">original</div></MessageActions>));
}
function button(label: string) {
    const result = [...host.querySelectorAll('button')].find(el => el.textContent === label);
    expect(result, `button ${label}`).toBeDefined(); return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }
function type(text: string) {
    const input = host.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('inline message editor', () => {
    it('edits in place immediately and cancels without a read or write', async () => {
        render(); await click('Edit');
        expect(host.querySelector('.original-bubble')).toBeNull();
        expect(host.querySelector('textarea')?.value).toBe('original');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        type('draft'); await click('Cancel');
        expect(host.querySelector('.original-bubble')?.textContent).toBe('original');
        expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
        await click('Edit'); expect(host.querySelector('textarea')?.value).toBe('original');
    });
    it('ignores IME Escape and closes on ordinary Escape', async () => {
        render(); await click('Edit');
        act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
        expect(host.querySelector('textarea')).not.toBeNull();
        act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(host.querySelector('textarea')).toBeNull();
    });
    it('verifies the exact history point before creating and sending the edited text', async () => {
        render(); await click('Edit'); type('revised'); await click('Send in new branch');
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('machine', 'claude-list-rewind-points', { directory: '/repo', claudeSessionId: 'source' });
        expect(mocks.create.mock.calls[0][0]).toMatchObject({ pointId: 'point', messageId: 'msg' });
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith('branch', 'revised', { source: 'chat' });
        expect(mocks.navigate).toHaveBeenCalledWith('/session/branch');
    });
    it.each([{ type: 'success', points: [{ uuid: 'wrong', text: 'original' }] }, { error: 'unavailable' }, { type: 'success', points: [{ uuid: 'point', hasAttachments: true }] }])('refuses invalid or mismatched history %j', async response => {
        mocks.rpc.mockResolvedValue(response); render(); await click('Edit'); type('retained'); await click('Send in new branch');
        expect(mocks.create).not.toHaveBeenCalled(); expect(host.querySelector('textarea')?.value).toBe('retained');
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });
    it('requires explicit selection for legacy history rather than guessing equal text', async () => {
        render({ ...message, claudeUuid: undefined }); await click('Edit');
        expect(host.querySelector('textarea')).toBeNull(); expect(button('Send in new branch').disabled).toBe(true);
        act(() => { const select = host.querySelector('select')!; select.value = 'point'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(host.querySelector('textarea')?.value).toBe('original');
    });
    it('rechecks the source after the asynchronous history response', async () => {
        mocks.rpc.mockImplementation(async () => { mocks.state.sessions.parent.metadata!.claudeSessionId = 'other-source'; return { type: 'success', points: [{ uuid: 'point' }] }; });
        render(); await click('Edit'); await click('Send in new branch');
        expect(mocks.create).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('session changed');
    });
    it('refuses to fork when the source starts working during history verification', async () => {
        mocks.rpc.mockImplementation(async () => {
            mocks.state.sessions.parent.thinking = true;
            mocks.state.sessions.parent.presence = 'online';
            return { type: 'success', points: [{ uuid: 'point' }] };
        });
        render(); await click('Edit'); await click('Send in new branch');
        expect(mocks.create).not.toHaveBeenCalled();
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('Stop the current run');
    });
    it('keeps the new branch and edited draft when sending fails without repeating mutation', async () => {
        mocks.send.mockRejectedValue(new Error('offline')); render(); await click('Edit'); type('retained'); await click('Send in new branch');
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('branch was created');
        expect(mocks.state.updateSessionDraft).toHaveBeenCalledWith('branch', 'retained');
        await click('Open new branch'); expect(mocks.create).toHaveBeenCalledTimes(1);
    });
    it('does not retry an ambiguous mutation even after closing and reopening', async () => {
        mocks.create.mockRejectedValue(new Error('timeout')); render(); await click('Edit'); await click('Send in new branch');
        expect(button('Send in new branch').disabled).toBe(true);
        await click('Cancel'); await click('Edit'); expect(button('Send in new branch').disabled).toBe(true);
        expect(mocks.create).toHaveBeenCalledTimes(1);
    });
});
