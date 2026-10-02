// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserTextMessage } from '@/sync/typesMessage';

const mocks = vi.hoisted(() => ({ send: vi.fn(), rewind: vi.fn(), flavor: 'claude' as string | undefined, enterToSend: true }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessionMessages: {} }) },
    useSession: () => ({ metadata: { flavor: mocks.flavor } }),
    useSetting: () => mocks.enterToSend,
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('./conversationRewind', async (original) => ({ ...await original<typeof import('./conversationRewind')>(), rewindConversation: mocks.rewind }));
import { MessageActions } from './MessageActions';
import { RewindFailure } from './conversationRewind';
import { onMessageQuote } from './messageQuote';
import { compactMessageTime, messageTimestamp } from './messageTimestamp';

let host: HTMLDivElement;
let root: Root;
const message = { kind: 'user-text', id: 'msg', localId: null, seq: 1, text: 'original', createdAt: 1, claudeUuid: 'point' } satisfies UserTextMessage;
const CREATED_AT = Date.UTC(2026, 8, 11, 12, 34, 56);
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.send.mockResolvedValue({ id: 'receipt' });
    mocks.rewind.mockResolvedValue(undefined);
    mocks.flavor = 'claude';
    mocks.enterToSend = true;
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
        expect(controls.map(control => control.getAttribute('aria-label'))).toEqual(['message.copyMessage', 'Quote', 'Edit', 'Delete']);
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
        expect(time?.textContent).toBe(compactMessageTime(CREATED_AT, 'en', undefined, Date.now()));
        expect(time?.getAttribute('datetime')).toBe(new Date(CREATED_AT).toISOString());
        expect(time?.title).toBe(messageTimestamp(CREATED_AT, 'en'));
    });

    it('falls back to the user message creation time when no explicit time is supplied', () => {
        render({ ...message, createdAt: CREATED_AT });
        expect(host.querySelector('time')?.textContent).toBe(compactMessageTime(CREATED_AT, 'en', undefined, Date.now()));
        expect(host.querySelector('time')?.title).toBe(messageTimestamp(CREATED_AT, 'en'));
    });

    it.each([undefined, 0, -1, NaN, Infinity, 1e20])('omits an unavailable or invalid time (%s) without hiding valid actions', createdAt => {
        act(() => root.render(<MessageActions text="original" sessionId="parent" createdAt={createdAt} />));
        expect(host.querySelector('time')).toBeNull();
        expect(host.querySelectorAll('.msg-actions button')).toHaveLength(2);
    });

    it('renders only the time for an attachment-only message instead of copying or quoting empty text', () => {
        act(() => root.render(<MessageActions text="" sessionId="parent" userMessage={{ ...message, createdAt: CREATED_AT }} hasAttachments />));
        expect(host.querySelector('time')?.textContent).toBe(compactMessageTime(CREATED_AT, 'en', undefined, Date.now()));
        expect(host.querySelectorAll('.msg-actions button')).toHaveLength(0);
    });

    it('copies the complete raw text and quotes into the matching session without sending anything', async () => {
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
            expect(mocks.send).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            unsubscribeOther();
        }
    });
});

describe('in-place edit (B-528: replaces history)', () => {
    it('turns the bubble into a prefilled editor and replaces the conversation from this message', async () => {
        render(); await click('Edit');
        expect(host.querySelector('.original-bubble')).toBeNull();
        expect(host.querySelector('.msg-actions')).toBeNull();
        expect(host.querySelector('textarea')?.value).toBe('original');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        type('revised'); await click('Send');
        expect(mocks.rewind).toHaveBeenCalledExactlyOnceWith('parent', message, { action: 'edit', text: 'revised' });
        // Never the old "send a new message" path directly.
        expect(mocks.send).not.toHaveBeenCalled();
        expect(host.querySelector('textarea')).toBeNull();
    });

    it('Enter sends, Shift+Enter keeps a newline, and IME Enter never sends', async () => {
        render(); await click('Edit'); type('line');
        const textarea = () => host.querySelector('textarea')!;
        act(() => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
        act(() => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); });
        expect(mocks.rewind).not.toHaveBeenCalled();
        await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(mocks.rewind).toHaveBeenCalledOnce();
    });

    it('follows the composer setting: with Enter-to-send off only Cmd/Ctrl+Enter sends', async () => {
        mocks.enterToSend = false;
        render(); await click('Edit'); type('line');
        const textarea = () => host.querySelector('textarea')!;
        act(() => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(mocks.rewind).not.toHaveBeenCalled();
        await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
        expect(mocks.rewind).toHaveBeenCalledOnce();
    });

    it('unchanged text just closes; cancel and Escape restore the bubble without touching the agent', async () => {
        render(); await click('Edit'); await click('Send');
        expect(mocks.rewind).not.toHaveBeenCalled();
        expect(host.querySelector('.original-bubble')).not.toBeNull();
        await click('Edit'); type('draft'); await click('Cancel');
        expect(host.querySelector('.original-bubble')?.textContent).toBe('original');
        await click('Edit'); expect(host.querySelector('textarea')?.value).toBe('original');
        act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
        expect(host.querySelector('textarea')).not.toBeNull();
        act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(host.querySelector('textarea')).toBeNull();
        expect(mocks.rewind).not.toHaveBeenCalled();
    });

    it('keeps the editor and the text with an actionable error, then retries', async () => {
        mocks.rewind.mockRejectedValueOnce(new RewindFailure('unsupported', 'Method not found'));
        render(); await click('Edit'); type('retry me'); await click('Send');
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('update the very-happy CLI');
        expect(host.querySelector('textarea')?.value).toBe('retry me');
        await click('Send');
        expect(mocks.rewind).toHaveBeenCalledTimes(2);
        expect(host.querySelector('textarea')).toBeNull();
    });

    it('disables send for whitespace-only text', async () => {
        render(); await click('Edit'); type('   ');
        expect(button('Send').disabled).toBe(true);
    });
});

describe('delete (B-528)', () => {
    it('asks inline, then removes the turn; cancel leaves everything alone', async () => {
        render(); await click('Delete');
        expect(host.querySelector('.msg-delete-confirm')?.textContent).toContain('Delete this message and its replies?');
        expect(host.querySelector('.original-bubble')).not.toBeNull();
        await click('Cancel');
        expect(mocks.rewind).not.toHaveBeenCalled();
        await click('Delete');
        const confirm = [...host.querySelectorAll('.msg-delete-confirm button')].find(el => el.textContent?.trim() === 'Delete') as HTMLButtonElement;
        await act(async () => confirm.click());
        expect(mocks.rewind).toHaveBeenCalledExactlyOnceWith('parent', message, { action: 'delete' });
        expect(host.querySelector('.msg-delete-confirm')).toBeNull();
    });
});

describe('who gets edit/delete', () => {
    it.each([
        ['codex session', { flavor: 'codex' }, message],
        ['mirror', { flavor: 'terminal-mirror' }, message],
        ['unconfirmed message', {}, { ...message, seq: null }],
    ])('hides them for a %s', (_name, overrides, userMessage) => {
        if ('flavor' in overrides) mocks.flavor = overrides.flavor;
        render(userMessage as UserTextMessage);
        const labels = [...host.querySelectorAll('.msg-actions button')].map(el => el.getAttribute('aria-label'));
        expect(labels).toEqual(['message.copyMessage', 'Quote']);
    });
});
