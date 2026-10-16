import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-611 scroll edge fade. The visual proof is pixel-sampled in a real browser
 * (alpha ≈ 1 at a scrolled-to edge, ≈ 0.03 at an edge with more content);
 * these pin the structural rules that keep it safe:
 *  - the mask lives ONLY inside `@supports (animation-timeline: scroll())`, so
 *    an engine without scroll timelines gets no mask at all (a static mask
 *    there would fade the first row even at scrollTop 0);
 *  - the transcript and the terminal never opt in.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(new URL('./scrollFade.css', import.meta.url), 'utf8'));

describe('B-611 .vh-scroll-fade', () => {
    it('only masks inside the scroll-timeline @supports block', () => {
        const at = css.indexOf('@supports (animation-timeline: scroll())');
        expect(at).toBeGreaterThan(-1);
        expect(css.indexOf('mask-image')).toBeGreaterThan(at);
        expect(css.match(/mask-image/g)).toHaveLength(1);
    });

    it('drives both edges from the element\'s own block scroll timeline', () => {
        expect(css).toMatch(/animation-timeline:\s*scroll\(self block\),\s*scroll\(self block\);/);
        expect(css).toMatch(/@property --vh-fade-top \{[^}]*initial-value: 0px;/);
        expect(css).toMatch(/@property --vh-fade-bottom \{[^}]*initial-value: 0px;/);
    });

    it('is not applied to the chat transcript or the terminal', () => {
        for (const rel of ['../screens/session/ChatList.tsx', '../screens/terminal/WebTerminalScreen.tsx']) {
            expect(readFileSync(new URL(rel, import.meta.url), 'utf8')).not.toContain('vh-scroll-fade');
        }
    });
});
