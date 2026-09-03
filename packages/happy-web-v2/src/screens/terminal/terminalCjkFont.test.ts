import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { terminalCjkFontLinks, TERMINAL_CJK_FONT_FAMILY } from './terminalCjkFont';
import { TERM_FONT, TERM_FONT_STACK } from './termFont';

describe('terminal CJK font', () => {
    it('exposes the dual-width family used as the primary terminal font', () => {
        expect(TERMINAL_CJK_FONT_FAMILY).toBe('Maple Mono CN');
    });

    it('builds exactly the Regular + Bold CDN stylesheet links', () => {
        const links = terminalCjkFontLinks();
        expect(links).toHaveLength(2);
        expect(links.map((l) => l.weight)).toEqual(['regular', 'bold']);
        expect(links.map((l) => l.href)).toEqual([
            'https://veryhappy-fonts.pages.dev/maple-cn/regular/result.css',
            'https://veryhappy-fonts.pages.dev/maple-cn/bold/result.css',
        ]);
        // Absolute https CDN urls (the woff2 the CSS references are same-origin
        // to the CSS and CORS-enabled), never a bundled/relative path.
        expect(links.every((l) => l.href.startsWith('https://'))).toBe(true);
    });

    it('injection is guarded: idempotent + SSR-safe (source contract)', () => {
        const src = readFileSync(new URL('./terminalCjkFont.ts', import.meta.url), 'utf8');
        // Only injects once, and never touches document when there is none.
        expect(src).toContain('if (injected || typeof document === \'undefined\') return;');
        expect(src).toContain('injected = true;');
        // Uses the pure link list rather than duplicating the URL logic.
        expect(src).toContain('for (const { weight, href } of terminalCjkFontLinks())');
    });

    it('TERM_FONT lists the CJK family first in the terminal stack', () => {
        // B-316: asserted against the shared constant rather than the screen's
        // source text — the stack moved into termFont.ts precisely so the face
        // we wait for and the face we render with cannot drift apart.
        expect(TERM_FONT_STACK[0]).toBe(TERMINAL_CJK_FONT_FAMILY);
        expect(TERM_FONT.startsWith(`'${TERMINAL_CJK_FONT_FAMILY}'`)).toBe(true);
        // and the loader is invoked on mount
        const screen = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');
        expect(screen).toContain('ensureTerminalCjkFont();');
    });

    it('shows a font-loading hint only when the slices are not already cached', () => {
        const screen = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');
        // Guarded on fonts.check so a repeat open (cached) shows nothing.
        expect(screen).toContain('if (fontsApi?.check && !fontsApi.check(fontQuery)) setCjkFontLoading(true);');
        // Cleared on load/settle/timeout, and rendered as a chip.
        expect(screen).toContain('setTimeout(stopHint, 8000)');
        expect(screen).toContain("t('terminal.fontLoading')");
    });

    it('re-measures the cell when the CDN font swaps in (Maple advance != Plex 0.6em)', () => {
        const screen = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');
        // document.fonts.ready resolves before the CDN css is fetched, so there
        // MUST be an explicit load-then-remeasure for the CJK family.
        expect(screen).toContain("const fontQuery = `${cjkSize}px '${TERMINAL_CJK_FONT_FAMILY}'`;");
        expect(screen).toContain("fontsApi?.load?.(fontQuery, 'Mgqw0')");
        expect(screen).toContain('renderer.remeasureFont(); scheduleFit();');
    });
});
