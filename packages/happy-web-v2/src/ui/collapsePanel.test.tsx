/**
 * B-612: height-animated disclosure. Browser behaviour (transition, unmount on
 * transitionend) is verified in Chromium/WebKit; these pin the markup + CSS
 * contract. When it auto-closes is useLiveDisclosure's job (its own test).
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CollapsePanel } from './CollapsePanel';

describe('B-612 CollapsePanel markup', () => {
    it('open: content mounted, panel expanded', () => {
        const html = renderToStaticMarkup(<CollapsePanel id="p" open className="body"><p>secret</p></CollapsePanel>);
        expect(html).toBe('<div id="p" class="vh-collapse is-open"><div class="vh-collapse-inner"><div class="body"><p>secret</p></div></div></div>');
    });

    it('closed: hidden and content NOT in the DOM', () => {
        const html = renderToStaticMarkup(<CollapsePanel id="p" open={false} className="body"><p>secret</p></CollapsePanel>);
        expect(html).toContain('hidden');
        expect(html).not.toContain('secret');
    });

    it('css: grid-rows transition on motion tokens, clip (not hidden) inner, reduced motion off', () => {
        const css = readFileSync(new URL('../styles/base.css', import.meta.url), 'utf8');
        const block = css.slice(css.indexOf('.vh-collapse {'));
        expect(block).toMatch(/\.vh-collapse \{[^}]*grid-template-rows: 0fr;[^}]*transition: grid-template-rows var\(--motion-med\)/);
        expect(block).toMatch(/\.vh-collapse\.is-open \{[^}]*grid-template-rows: 1fr;/);
        expect(block).toMatch(/\.vh-collapse\[hidden\] \{\s*display: none;/);
        expect(block).toMatch(/\.vh-collapse-inner \{[^}]*min-height: 0;[^}]*overflow: clip;/);
        expect(block).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.vh-collapse \{\s*transition: none;/);
    });
});
