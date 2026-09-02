import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitTerminalFont, TERMINAL_FONT_FAMILY } from './termFont';

const g = globalThis as unknown as { document?: { fonts?: unknown } };
const orig = g.document?.fonts;
afterEach(() => { if (g.document) g.document.fonts = orig; });

function setFonts(fonts: unknown) {
    if (!g.document) (g as { document?: unknown }).document = {};
    (g.document as { fonts?: unknown }).fonts = fonts;
}

describe('awaitTerminalFont (B-289)', () => {
    it('resolves immediately when document.fonts is unavailable', async () => {
        setFonts(undefined);
        await expect(awaitTerminalFont(13, 3000)).resolves.toBeUndefined();
    });

    it('queries the terminal mono family at the given size, weight-agnostic', async () => {
        const load = vi.fn().mockResolvedValue([]);
        setFonts({ load });
        await awaitTerminalFont(13, 3000);
        expect(load).toHaveBeenCalledWith(`13px '${TERMINAL_FONT_FAMILY}'`);
    });

    it('resolves via the timeout when the font never loads (offline/blocked)', async () => {
        vi.useFakeTimers();
        setFonts({ load: () => new Promise(() => { /* never resolves */ }) });
        const p = awaitTerminalFont(13, 300);
        let done = false;
        p.then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(299);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(done).toBe(true);
        vi.useRealTimers();
    });

    it('never rejects even if fonts.load throws synchronously', async () => {
        setFonts({ load: () => { throw new Error('boom'); } });
        await expect(awaitTerminalFont(13, 3000)).resolves.toBeUndefined();
    });

    it('never rejects when fonts.load returns a rejected promise', async () => {
        setFonts({ load: () => Promise.reject(new Error('nope')) });
        await expect(awaitTerminalFont(13, 3000)).resolves.toBeUndefined();
    });
});
