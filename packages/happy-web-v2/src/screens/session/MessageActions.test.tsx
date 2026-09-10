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
import { onMessageQuote } from './messageQuote';
import { compactMessageTime, messageTimestamp } from './messageTimestamp';

let host: HTMLDivElement;
let root: Root;
const message = { kind: 'user-text', id: 'msg', localId: null, seq: 1, text: 'original', createdAt: 1, claudeUuid: 'point' } satisfies UserTextMessage;
const CREATED_AT = Date.UTC(2026, 8, 11, 12, 34, 56);
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
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
function render(userMessage: UserTextMessage = message) {
    act(() => root.render(<MessageActions text="original" sessionId="parent" userMessage={userMessage}><div className="original-bubble">original</div></MessageActions>));
}
function button(label: string) {
    const buttons = [...host.querySelectorAll('button')];
    const result = buttons.find(el => el.getAttribute('aria-label') === label)
        ?? buttons.find(el => !el.hasAttribute('aria-label') && el.textContent?.trim() === label);
    expect(result, `button ${label}`).toBeDefined(); return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }
function type(text: string) {
    const input = host.querySelector('textarea')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('persistent message action row', () => {
    it('renders named icon buttons with their own operation hints and no visible text labels', () => {
        render();
        const controls = [...host.querySelectorAll<HTMLButtonElement>('.msg-actions button')];
        expect(controls.map(control => control.getAttribute('aria-label'))).toEqual(['message.copyMessage', 'Quote', 'Edit']);
        for (const control of controls) {
            expect(control.textContent?.trim()).toBe('');
            expect(control.querySelector('svg')).not.toBeNull();
            expect(control.title).toBe(control.getAttribute('aria-label'));
        }
    });

    it('shows the explicit creation time beside actions with its full date in the hover hint', () => {
        act(() => root.render(<MessageActions text="original" sessionId="parent" userMessage={message} createdAt={CREATED_AT} />));
        const time = host.querySelector('time');
        expect(time?.closest('.msg-actions')).not.toBeNull();
        expect(time?.textContent).toBe(compactMessageTime(CREATED_AT, 'en'));
        expect(time?.getAttribute('datetime')).toBe(new Date(CREATED_AT).toISOString());
        expect(time?.title).toBe(messageTimestamp(CREATED_AT, 'en'));
    });

    it('falls back to the user message creation time when no explicit time is supplied', () => {
        render({ ...message, createdAt: CREATED_AT });
        expect(host.querySelector('time')?.textContent).toBe(compactMessageTime(CREATED_AT, 'en'));
        expect(host.querySelector('time')?.title).toBe(messageTimestamp(CREATED_AT, 'en'));
    });

    it.each([undefined, 0, -1, NaN, Infinity, 1e20])('omits an unavailable or invalid time (%s) without hiding valid actions', createdAt => {
        act(() => root.render(<MessageActions text="original" sessionId="parent" createdAt={createdAt} />));
        expect(host.querySelector('time')).toBeNull();
        expect(host.querySelectorAll('.msg-actions button')).toHaveLength(2);
    });

    it('renders only the time for an attachment-only message instead of copying or quoting empty text', () => {
        act(() => root.render(<MessageActions text="" sessionId="parent" userMessage={{ ...message, createdAt: CREATED_AT }} hasAttachments />));
        expect(host.querySelector('time')?.textContent).toBe(compactMessageTime(CREATED_AT, 'en'));
        expect(host.querySelectorAll('.msg-actions button')).toHaveLength(0);
    });

    it('still copies the complete raw text and quotes into the matching session', async () => {
        const raw = 'First line\nSecond line';
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        const quote = vi.fn();
        const otherSession = vi.fn();
        const unsubscribe = onMessageQuote('parent', quote);
        const unsubscribeOther = onMessageQuote('other', otherSession);
        try {
            act(() => root.render(<MessageActions text={raw} sessionId="parent" createdAt={CREATED_AT} />));
            await click('message.copyMessage');
            expect(write).toHaveBeenCalledExactlyOnceWith(raw);
            await click('Quote');
            expect(quote).toHaveBeenCalledExactlyOnceWith(raw);
            expect(otherSession).not.toHaveBeenCalled();
            expect(mocks.rpc).not.toHaveBeenCalled();
            expect(mocks.send).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            unsubscribeOther();
        }
    });
});

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
