// @vitest-environment happy-dom
/** Owner 10-27 「创建出来了，就是不明显」: every user-started dispatch toasts, reveals and marks 「新」. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui/Toast';
import {
    DISPATCH_HIGHLIGHT_MS, DISPATCH_REVEAL_TTL_MS, DISPATCH_TOAST_MS, FRESH_MAX, FRESH_TTL_MS,
    announceDispatched, announceDispatchFailed, consumeDispatchReveal, getDispatchFeedbackState, liveReveal,
    markFresh, noteDispatchRoute, pruneFresh, resetDispatchFeedbackForTests, sessionIdOfPath, setDispatchNavigator,
} from './dispatchFeedback';

describe('dispatch feedback', () => {
    let host: HTMLDivElement; let root: Root;
    beforeEach(async () => {
        vi.useFakeTimers();
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        localStorage.clear();
        resetDispatchFeedbackForTests();
        host = document.createElement('div'); document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(<ToastProvider><span /></ToastProvider>));
    });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

    it('toasts 「已创建 <名字> 的会话 · 打开」; 打开 routes to the session; the toast outlives the default', async () => {
        const navigate = vi.fn();
        const off = setDispatchNavigator(navigate);
        await act(async () => announceDispatched({ sessionId: 's 1', name: 'Dev-A2' }));
        const el = host.querySelector('.vh-toast--button') as HTMLElement;
        expect(el.querySelector('.vh-toast-text')?.textContent).toBe('Started a session for Dev-A2');
        const btn = el.querySelector('button.vh-toast-btn') as HTMLButtonElement;
        expect(btn.textContent).toBe('Open');
        await act(async () => { vi.advanceTimersByTime(DISPATCH_TOAST_MS - 1); });
        expect(host.querySelector('.vh-toast--button')).not.toBeNull();
        await act(async () => btn.click());
        expect(navigate).toHaveBeenCalledWith('/session/s%201');
        off();
    });

    it('marks 「新」 and arms one reveal; consuming it highlights ~3 s; opening the session clears 「新」', async () => {
        await act(async () => announceDispatched({ sessionId: 's1', name: 'x', now: 1000 }));
        const st = getDispatchFeedbackState();
        expect(Object.keys(st.fresh)).toEqual(['s1']);
        expect(st.reveal?.sessionId).toBe('s1');
        expect(JSON.parse(localStorage.getItem('vh.dispatch.fresh.v1')!)).toEqual({ s1: 1000 });
        consumeDispatchReveal(st.reveal!.seq + 1); // a stale seq is ignored
        expect(getDispatchFeedbackState().reveal).not.toBeNull();
        consumeDispatchReveal(st.reveal!.seq);
        expect(getDispatchFeedbackState().reveal).toBeNull();
        expect(getDispatchFeedbackState().highlight?.sessionId).toBe('s1');
        vi.advanceTimersByTime(DISPATCH_HIGHLIGHT_MS);
        expect(getDispatchFeedbackState().highlight).toBeNull();
        noteDispatchRoute('/session/other');
        expect('s1' in getDispatchFeedbackState().fresh).toBe(true);
        noteDispatchRoute('/session/s1/files');
        expect(getDispatchFeedbackState().fresh).toEqual({});
        expect(JSON.parse(localStorage.getItem('vh.dispatch.fresh.v1')!)).toEqual({});
    });

    it('a delivery (task to a live member) and a session already on screen get no 「新」', async () => {
        await act(async () => announceDispatched({ sessionId: 'live', name: 'Lead', kind: 'delivered' }));
        expect(host.querySelector('.vh-toast-text')?.textContent).toBe('Task sent to Lead');
        noteDispatchRoute('/session/here');
        await act(async () => announceDispatched({ sessionId: 'here' }));
        expect(getDispatchFeedbackState().fresh).toEqual({});
        expect(getDispatchFeedbackState().reveal?.sessionId).toBe('here');
    });

    it('failure toasts the reason', async () => {
        await act(async () => announceDispatchFailed({ name: 'Dev-A2', reason: 'machine_offline' }));
        const el = host.querySelector('.vh-toast--error') as HTMLElement;
        expect(el.textContent).toBe('Could not start a session for Dev-A2: machine_offline');
        await act(async () => announceDispatchFailed({ reason: '' }));
        expect(host.querySelectorAll('.vh-toast--error')[1].textContent).toBe('Could not start the session: unknown_error');
    });

    it('markFresh (batch import) marks without a toast and skips the open session', async () => {
        noteDispatchRoute('/session/b');
        await act(async () => markFresh(['a', 'b', 'c'], 5));
        expect(Object.keys(getDispatchFeedbackState().fresh).sort()).toEqual(['a', 'c']);
        expect(host.querySelector('.vh-toast')).toBeNull();
    });
});

describe('dispatch feedback — pure parts', () => {
    it('pruneFresh drops expired / malformed marks and keeps the newest FRESH_MAX', () => {
        const now = FRESH_TTL_MS * 2;
        const many = Object.fromEntries(Array.from({ length: FRESH_MAX + 5 }, (_, i) => [`s${i}`, now - i]));
        const kept = pruneFresh({ ...many, old: now - FRESH_TTL_MS, bad: Number.NaN }, now);
        expect(Object.keys(kept)).toHaveLength(FRESH_MAX);
        expect(kept.s0).toBe(now);
        expect('old' in kept || 'bad' in kept || `s${FRESH_MAX}` in kept).toBe(false);
    });
    it('sessionIdOfPath reads /session/<id> and its sub-pages only', () => {
        expect(sessionIdOfPath('/session/abc')).toBe('abc');
        expect(sessionIdOfPath('/session/a%20b/files')).toBe('a b');
        expect(sessionIdOfPath('/teams/x')).toBeNull();
    });
    it('a reveal lapses after its TTL', () => {
        const r = { sessionId: 's', seq: 1, at: 0 };
        expect(liveReveal(r, DISPATCH_REVEAL_TTL_MS - 1)).toBe(r);
        expect(liveReveal(r, DISPATCH_REVEAL_TTL_MS)).toBeNull();
    });
});
