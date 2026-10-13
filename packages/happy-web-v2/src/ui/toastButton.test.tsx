// @vitest-environment happy-dom
/** B-566: text + button toasts, without breaking the old clickable-body action. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, toast } from './Toast';

describe('toast button', () => {
    let host: HTMLDivElement; let root: Root;
    beforeEach(async () => {
        vi.useFakeTimers();
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        host = document.createElement('div'); document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(<ToastProvider><span /></ToastProvider>));
    });
    afterEach(async () => {
        await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
    });

    it('renders "text · button"; only the button acts; dismisses after the given window', async () => {
        const onUndo = vi.fn();
        await act(async () => toast.undoable('Archived', 'Undo', onUndo, 6000));
        const el = host.querySelector('.vh-toast--button') as HTMLElement;
        expect(el.querySelector('.vh-toast-text')?.textContent).toBe('Archived');
        const btn = el.querySelector('button.vh-toast-btn') as HTMLButtonElement;
        expect(btn.textContent).toBe('Undo');
        await act(async () => el.click()); // body click: no action, stays
        expect(onUndo).not.toHaveBeenCalled();
        expect(host.querySelector('.vh-toast--button')).not.toBeNull();
        await act(async () => { vi.advanceTimersByTime(5999); });
        expect(host.querySelector('.vh-toast--button')).not.toBeNull();
        await act(async () => btn.click());
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(host.querySelector('.vh-toast--button')).toBeNull();
    });

    it('auto-dismisses at durationMs', async () => {
        await act(async () => toast.undoable('Archived', 'Undo', vi.fn(), 6000));
        await act(async () => { vi.advanceTimersByTime(6000); });
        expect(host.querySelector('.vh-toast')).toBeNull();
    });

    it('legacy toast.action still runs on a body click', async () => {
        const onAction = vi.fn();
        await act(async () => toast.action('Copy now', onAction));
        const el = host.querySelector('.vh-toast--action') as HTMLElement;
        await act(async () => el.click());
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(host.querySelector('.vh-toast')).toBeNull();
    });
});
