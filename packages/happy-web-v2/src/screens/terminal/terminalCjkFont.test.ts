import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { terminalCjkFontLinks, TERMINAL_CJK_FONT_FAMILY } from './terminalCjkFont';

describe('terminal CJK font', () => {
    it('exposes the dual-width family used as the primary terminal font', () => {
        expect(TERMINAL_CJK_FONT_FAMILY).toBe('Sarasa Fixed SC');
    });

    it('builds exactly the Regular + Bold CDN stylesheet links', () => {
        const links = terminalCjkFontLinks();
        expect(links).toHaveLength(2);
        expect(links.map((l) => l.weight)).toEqual(['regular', 'bold']);
        expect(links.map((l) => l.href)).toEqual([
            'https://veryhappy-fonts.pages.dev/regular/result.css',
            'https://veryhappy-fonts.pages.dev/bold/result.css',
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
        const screen = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');
        expect(screen).toMatch(/const TERM_FONT = "'Sarasa Fixed SC',/);
        // and the loader is invoked on mount
        expect(screen).toContain('ensureTerminalCjkFont();');
    });

    it('re-measures the cell when the CDN font swaps in (Iosevka 0.5em != Plex 0.6em)', () => {
        const screen = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');
        // document.fonts.ready resolves before the CDN css is fetched, so there
        // MUST be an explicit load-then-remeasure for the CJK family.
        expect(screen).toContain("fonts?.load?.(`${cjkSize}px '${TERMINAL_CJK_FONT_FAMILY}'`, 'Mgqw0')");
        expect(screen).toContain('renderer.remeasureFont(); scheduleFit();');
    });
});
