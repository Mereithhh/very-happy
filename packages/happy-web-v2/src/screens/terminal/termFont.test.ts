import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitTerminalFont, TERM_FONT, TERM_FONT_STACK, TERMINAL_FONT_FAMILY, TERMINAL_WEB_FONT_FAMILIES } from './termFont';

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

describe('TERM_FONT stack (B-316)', () => {
    it('renders with the same first family the measurement waits for', () => {
        // The drift this guards: the terminal moved to Maple Mono CN while the
        // wait still named IBM Plex Mono, so the cell was measured from the
        // fallback and the grid came out wrong.
        expect(TERM_FONT_STACK[0]).toBe(TERMINAL_WEB_FONT_FAMILIES[0]);
        expect(TERM_FONT.startsWith(`'${TERM_FONT_STACK[0]}'`)).toBe(true);
    });

    it('waits for every web font in the stack, not just the bundled one', () => {
        for (const family of TERMINAL_WEB_FONT_FAMILIES) {
            expect(TERM_FONT_STACK).toContain(family);
        }
    });

    it('leaves generic families unquoted so the CSS stays valid', () => {
        expect(TERM_FONT).toContain('ui-monospace,');
        expect(TERM_FONT.endsWith('monospace')).toBe(true);
        expect(TERM_FONT).not.toContain("'monospace'");
    });
});
