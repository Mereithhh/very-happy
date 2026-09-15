// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    HOVER_TIME_PARKED_ATTR,
    HOVER_TIME_ROW_SELECTOR,
    clampTooltipPosition,
    hoverTimeTargetFrom,
    hoverTimeTextOf,
    supportsHoverTooltip,
} from './messageHoverTime';

const html = (markup: string) => {
    const root = document.createElement('div');
    root.innerHTML = markup;
    document.body.appendChild(root);
    return root;
};

describe('B-473 transcript hover time', () => {
    it('resolves the row under the pointer, ignoring buttons and anything outside the transcript', () => {
        const root = html(`
            <div class="msg" title="2026/09/11 20:34:56 (GMT+8)">
                <div class="md"><p id="prose">body</p></div>
                <div class="msg-actions"><button id="copy" class="vh-copy" title="Copy message"></button></div>
            </div>
            <div class="tg-row" id="tool" title="2026/09/11 20:35:00 (GMT+8)"></div>
            <div class="msg" id="untimed"></div>`);
        const outside = html('<div class="msg" id="stray" title="2026/09/11 20:00:00 (GMT+8)"></div>');

        expect(hoverTimeTargetFrom(root.querySelector('#prose'), root)?.className).toBe('msg');
        // a button inside the row still resolves to the row: one bubble, the row's time
        expect(hoverTimeTargetFrom(root.querySelector('#copy'), root)?.className).toBe('msg');
        expect(hoverTimeTargetFrom(root.querySelector('#tool'), root)?.id).toBe('tool');
        // a row with no timestamp yet has nothing to show
        expect(hoverTimeTargetFrom(root.querySelector('#untimed'), root)).toBeNull();
        // a row outside the given transcript never matches
        expect(hoverTimeTargetFrom(outside.querySelector('#stray'), root)).toBeNull();
        expect(hoverTimeTargetFrom(null, root)).toBeNull();
        expect(hoverTimeTargetFrom(root.querySelector('#prose'), null)).toBeNull();
    });

    it('reads a parked title so a re-hover of the same row still has its time', () => {
        const row = document.createElement('div');
        row.className = 'msg';
        expect(hoverTimeTextOf(row)).toBeNull();
        row.setAttribute('title', '   ');
        expect(hoverTimeTextOf(row)).toBeNull();
        row.setAttribute('title', '2026/09/11 20:34:56 (GMT+8)');
        expect(hoverTimeTextOf(row)).toBe('2026/09/11 20:34:56 (GMT+8)');
        row.removeAttribute('title');
        row.setAttribute(HOVER_TIME_PARKED_ATTR, '2026/09/11 20:34:56 (GMT+8)');
        expect(hoverTimeTextOf(row)).toBe('2026/09/11 20:34:56 (GMT+8)');
    });

    it('places the bubble above the pointer and keeps it inside the viewport', () => {
        const size = { width: 200, height: 24 };
        const view = { width: 1000, height: 800 };
        expect(clampTooltipPosition({ x: 500, y: 400 }, size, view)).toEqual({ left: 400, top: 362 });
        // near the left/right edges it slides in rather than overflowing
        expect(clampTooltipPosition({ x: 5, y: 400 }, size, view).left).toBe(8);
        expect(clampTooltipPosition({ x: 995, y: 400 }, size, view).left).toBe(792);
        // no room above → flips below the pointer
        expect(clampTooltipPosition({ x: 500, y: 20 }, size, view).top).toBe(34);
        // a viewport narrower than the bubble still keeps the margin
        expect(clampTooltipPosition({ x: 50, y: 400 }, size, { width: 120, height: 800 }).left).toBe(8);
    });

    it('only takes over where hover actually exists', () => {
        expect(supportsHoverTooltip(undefined)).toBe(false);
        expect(supportsHoverTooltip({})).toBe(false);
        expect(supportsHoverTooltip({ matchMedia: () => ({ matches: true }) })).toBe(true);
        expect(supportsHoverTooltip({ matchMedia: () => ({ matches: false }) })).toBe(false);
        expect(supportsHoverTooltip({ matchMedia: () => { throw new Error('unsupported'); } })).toBe(false);
    });

    it('always hands the row its title back, and never covers a click', () => {
        // Verified with scripts/dev/mutation-check.mjs (see PR).
        const here = join(process.cwd(), 'src/screens/session');
        const source = readFileSync(join(here, 'MessageTimeTooltip.tsx'), 'utf8');
        const css = readFileSync(join(here, 'messageActions.css'), 'utf8');
        expect(source).toContain("if (text) parked.setAttribute('title', text);");
        for (const teardown of ['mouseleave', 'scroll', 'mousedown', 'blur']) expect(source).toContain(teardown);
        // release() runs on unmount too, so a row can never keep a blanked title
        expect(source).toContain('hide();\n        };\n    }, [containerRef]);');
        expect(css).toMatch(/\.msg-hover-time \{[^}]*pointer-events: none;/);
        expect(css).toMatch(/\.msg-hover-time \{[^}]*position: fixed;/);
        expect(HOVER_TIME_ROW_SELECTOR).not.toContain('button');
    });
});
