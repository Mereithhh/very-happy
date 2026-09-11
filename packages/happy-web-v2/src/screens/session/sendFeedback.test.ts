// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { yieldForSendFeedback } from './sendFeedback';

let frames: FrameRequestCallback[];

beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('send feedback paint opportunity', () => {
    it('waits through the frame, rather than resuming in its pre-paint microtasks', async () => {
        const started = vi.fn();
        const ready = yieldForSendFeedback().then(started);
        expect(frames).toHaveLength(1);
        frames[0](16);
        await Promise.resolve();
        expect(started).not.toHaveBeenCalled();
        await vi.runOnlyPendingTimersAsync();
        await ready;
        expect(started).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not wait for a frame on an already hidden page', async () => {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        const ready = yieldForSendFeedback();
        expect(frames).toHaveLength(0);
        await vi.runOnlyPendingTimersAsync();
        await ready;
    });

    it('finishes a pending send if its tab hides before the frame, and removes its listener', async () => {
        const remove = vi.spyOn(document, 'removeEventListener');
        const started = vi.fn();
        const ready = yieldForSendFeedback().then(started);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
        await vi.runOnlyPendingTimersAsync();
        await ready;
        expect(started).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        document.dispatchEvent(new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(0);
    });
});
