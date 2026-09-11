// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserTextMessage } from '@/sync/typesMessage';

const mocks = vi.hoisted(() => ({ send: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send } }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('@/ui/Toast', () => ({ toast: { success: mocks.toastSuccess } }));
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

describe('inline message editor (in-place resend)', () => {
    it('opens prefilled, resends the edited text into the SAME session, then closes', async () => {
        render(); await click('Edit');
        expect(host.querySelector('.original-bubble')).toBeNull();
        expect(host.querySelector('textarea')?.value).toBe('original');
        // No dialog/branch chrome and no reads on open.
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector('select')).toBeNull();
        type('revised'); await click('Resend');
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith('parent', 'revised', { source: 'chat' });
        expect(mocks.toastSuccess).toHaveBeenCalledOnce();
        // Stays in place: editor closes, the original bubble comes back.
        expect(host.querySelector('textarea')).toBeNull();
        expect(host.querySelector('.original-bubble')?.textContent).toBe('original');
    });

    it('cancels without sending and reopens from the original text', async () => {
        render(); await click('Edit'); type('draft'); await click('Cancel');
        expect(mocks.send).not.toHaveBeenCalled();
        expect(host.querySelector('.original-bubble')?.textContent).toBe('original');
        await click('Edit'); expect(host.querySelector('textarea')?.value).toBe('original');
    });

    it('ignores IME Escape and closes on ordinary Escape', async () => {
        render(); await click('Edit');
        act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
        expect(host.querySelector('textarea')).not.toBeNull();
        act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(host.querySelector('textarea')).toBeNull();
    });

    it('keeps the editor open with an error when sending fails, and can retry', async () => {
        mocks.send.mockRejectedValueOnce(new Error('offline'));
        render(); await click('Edit'); type('retry me'); await click('Resend');
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');
        expect(host.querySelector('textarea')?.value).toBe('retry me');
        await click('Resend');
        expect(mocks.send).toHaveBeenCalledTimes(2);
        expect(host.querySelector('textarea')).toBeNull();
    });

    it('disables resend for empty or whitespace-only text', async () => {
        render(); await click('Edit'); type('   ');
        expect(button('Resend').disabled).toBe(true);
    });
});
