/**
 * B-935 (Owner 11-14, iPad landscape): the nav rows left the session list ~270px.
 * They now scroll with the list inside `.sb-scroll`, and the view bar sticks.
 * Guards the CSS that makes that work: one scroller, a list that no longer
 * scrolls on its own (it would trap the wheel), a sticky opaque view bar.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((x) => x.trim()), body: m[2] }));
function decl(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rules.filter((x) => x.selectors.includes(selector))) {
        for (const d of r.body.split(';')) {
            const i = d.indexOf(':');
            if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
    }
    return out;
}

describe('sidebar single scroller (B-935)', () => {
    it('.sb-scroll is the scroller and fills the column', () => {
        expect(decl('.sb-scroll')).toMatchObject({ flex: '1', 'min-height': '0', 'overflow-y': 'auto' });
    });
    it('the list inside it grows instead of scrolling', () => {
        expect(decl('.sb-scroll > .sb-list')).toMatchObject({ overflow: 'visible', flex: '1 0 auto' });
    });
    it('the view bar sticks to the top on the sidebar surface', () => {
        expect(decl('.sb-scroll > .sb-list-controls')).toMatchObject({ position: 'sticky', top: '0', background: 'var(--surface-sidebar)' });
    });
    it('the override comes after the base .sb-list rule (same specificity loses otherwise)', () => {
        expect(css.indexOf('.sb-scroll > .sb-list')).toBeGreaterThan(css.indexOf('.sb-list {'));
    });
});
