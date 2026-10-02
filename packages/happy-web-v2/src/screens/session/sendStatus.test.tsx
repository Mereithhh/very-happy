// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserTextMessage } from '@/sync/typesMessage';

const mocks = vi.hoisted(() => ({ retry: vi.fn(), takeBack: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn(), retrySend: mocks.retry, takeBackFailedMessage: mocks.takeBack } }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('@/ui/Toast', () => ({ toast: { success: vi.fn() } }));
import { MessageActions } from './MessageActions';
import { useSendSpinnerResetAll } from './SendStatusView';
import { onComposerRestore } from './composerRestore';
import { clearSendSpinner, SEND_SPINNER_DELAY_MS, sendSpinnerRemaining, turnSendStatus } from './sendStatusModel';

const base = { kind: 'user-text', id: 'msg', localId: 'l1', seq: 7, text: 'hello', createdAt: Date.UTC(2026, 8, 30, 1, 2, 3) } satisfies UserTextMessage;

describe('turnSendStatus', () => {
    it('failed beats sending across text and attachments', () => {
        expect(turnSendStatus({ ...base, sendState: 'sending' }, [{ localId: 'f1', sendState: 'failed' }]))
            .toEqual({ state: 'failed', localId: 'f1', restorable: false });
        expect(turnSendStatus({ ...base, sendState: 'sending' }, [{ localId: 'f1' }]))
            .toEqual({ state: 'sending', localId: 'l1', restorable: false });
        expect(turnSendStatus(base, [{ localId: 'f1', sendState: 'sending' }]))
            .toEqual({ state: 'sending', localId: 'f1', restorable: false });
        expect(turnSendStatus(base)).toBeNull();
    });

    it('only a text-only restorable failure can go back to the composer', () => {
        expect(turnSendStatus({ ...base, sendState: 'failed', sendRestorable: true })?.restorable).toBe(true);
        expect(turnSendStatus({ ...base, sendState: 'failed', sendRestorable: true }, [{ localId: 'f1' }])?.restorable).toBe(false);
        expect(turnSendStatus({ ...base, sendState: 'failed' })?.restorable).toBe(false);
    });
});

describe('send spinner delay', () => {
    it('is timed per localId from first sight, not restarted by later renders', () => {
        clearSendSpinner('x');
        expect(sendSpinnerRemaining('x', 1000)).toBe(SEND_SPINNER_DELAY_MS);
        expect(sendSpinnerRemaining('x', 1100)).toBe(50);
        expect(sendSpinnerRemaining('x', 1150)).toBe(0);
        clearSendSpinner('x');
        expect(sendSpinnerRemaining('x', 5000)).toBe(SEND_SPINNER_DELAY_MS);
    });
});

describe('MessageActions send states', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks();
        vi.useFakeTimers();
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

    function render(message: UserTextMessage, attachments: { localId: string; sendState?: 'sending' | 'failed' }[] = []) {
        act(() => root.render(<MessageActions text={message.text} sessionId="s1" userMessage={message} send={turnSendStatus(message, attachments)} />));
    }
    const labels = () => [...host.querySelectorAll('.msg-actions button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);

    it('sending: copy only, time kept, spinner only after 150ms', () => {
        clearSendSpinner('l1');
        render({ ...base, sendState: 'sending' });
        expect(labels()).toEqual(['message.copyMessage']);
        expect(host.querySelector('time')).not.toBeNull();
        expect(host.querySelector('.msg-sending')).not.toBeNull();
        expect(host.querySelector('.vh-spinner')).toBeNull();
        act(() => { vi.advanceTimersByTime(SEND_SPINNER_DELAY_MS); });
        expect(host.querySelector('.vh-spinner')).not.toBeNull();
    });

    it('failed: replaces the time with 「failed · retry」; retry re-sends by localId', () => {
        render({ ...base, sendState: 'failed' });
        expect(host.querySelector('time')).toBeNull();
        expect(host.querySelector('.msg-send-failed')?.textContent).toContain('session.chat.sendFailed');
        expect(labels()).toEqual(['message.copyMessage', 'session.chat.sendRetry']);
        act(() => { (host.querySelector('.msg-send-action') as HTMLButtonElement).click(); });
        expect(mocks.retry).toHaveBeenCalledWith('s1', 'l1');
    });

    it('offers put-back only when restorable AND a composer is mounted, and hands the text over', () => {
        const received: string[] = [];
        render({ ...base, sendState: 'failed', sendRestorable: true });
        expect(labels()).not.toContain('session.chat.sendRestore');

        let off = () => {};
        act(() => { off = onComposerRestore('s1', (text) => received.push(text)); });
        expect(labels()).toContain('session.chat.sendRestore');
        mocks.takeBack.mockReturnValue('hello');
        const restore = [...host.querySelectorAll('button')].find((b) => b.textContent === 'session.chat.sendRestore')!;
        act(() => { restore.click(); });
        expect(mocks.takeBack).toHaveBeenCalledWith('s1', 'l1');
        expect(received).toEqual(['hello']);
        act(() => off());
        expect(labels()).not.toContain('session.chat.sendRestore');
    });

    it('a confirmed message shows the normal actions again', () => {
        render(base);
        expect(labels()).toEqual(['message.copyMessage', 'Quote', 'Edit', 'Delete']);
        expect(host.querySelector('.msg-send-failed, .msg-sending')).toBeNull();
    });
});

describe('queue dock spinner reset (review #5)', () => {
    it('forgets the spinner start of listed rows that stopped sending, so a retry waits 150ms again', () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        function Dock({ items }: { items: { localId: string; sendState?: 'sending' | 'failed' }[] }) {
            useSendSpinnerResetAll(items);
            return null;
        }
        clearSendSpinner('q1');
        sendSpinnerRemaining('q1', 0); // was sending since t=0
        act(() => root.render(<Dock items={[{ localId: 'q1', sendState: 'sending' }]} />));
        expect(sendSpinnerRemaining('q1', 1_000)).toBe(0);
        act(() => root.render(<Dock items={[{ localId: 'q1', sendState: 'failed' }]} />));
        // Retried at t=5000: a fresh delay, not an instant spinner.
        expect(sendSpinnerRemaining('q1', 5_000)).toBe(SEND_SPINNER_DELAY_MS);
        act(() => root.unmount());
        host.remove();
    });
});

it('the queue dock wires the reset for its rows', () => {
    expect(readFileSync(resolve(__dirname, 'ChatList.tsx'), 'utf8')).toMatch(/useSendSpinnerResetAll\(queuedMessages/);
});
