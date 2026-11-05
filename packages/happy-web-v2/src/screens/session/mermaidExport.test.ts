// @vitest-environment happy-dom
/** B-890: what the SVG / PNG downloads and the full-screen viewer are made of. */
import { describe, expect, it } from 'vitest';
import { pngScale, standaloneSvg } from './mermaidExport';

// The shape mermaid 11 emits: sized for the transcript, no background.
const MERMAID_SVG = '<svg id="mmd-r1-1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 234.5px; background-color: white;" viewBox="-8 -8 234.5 300" role="graphics-document document"><style>#mmd-r1-1{fill:#ecede8;}</style><g><text>A</text></g></svg>';

// happy-dom's DOMParser has no XML mode; the browser check covers the XML side.
const parseRoot = (svg: string) => new DOMParser().parseFromString(svg, 'text/html').body.firstElementChild!;

const child = (root: Element, tag: string) => Array.from(root.children).find((c) => c.localName === tag)!;

describe('standaloneSvg', () => {
    it('gives the diagram an intrinsic size from its viewBox and drops the transcript-only max-width', () => {
        const out = standaloneSvg(MERMAID_SVG, '#171815');
        expect(out).not.toBeNull();
        if (!out) return;
        expect(out.width).toBe(235);
        expect(out.height).toBe(300);
        const root = parseRoot(out.svg);
        expect(root.getAttribute('width')).toBe('235');
        expect(root.getAttribute('height')).toBe('300');
        expect(root.getAttribute('style')).not.toMatch(/max-width/);
        expect(root.getAttribute('style')).toMatch(/background-color/);
        expect(root.getAttribute('viewBox')).toBe('-8 -8 234.5 300');
    });

    it('bakes the theme background in as the first rect, bleeding past the viewBox, and keeps the drawing', () => {
        const out = standaloneSvg(MERMAID_SVG, '#171815');
        const root = parseRoot(out!.svg);
        const first = child(root, 'rect');
        expect(first.localName).toBe('rect');
        expect([first.getAttribute('x'), first.getAttribute('y'), first.getAttribute('width'), first.getAttribute('height')]).toEqual(['-242.5', '-308', '703.5', '900']);
        expect(first.getAttribute('fill')).toBe('#171815');
        expect(out!.svg).toContain('<text>A</text>');
        expect(out!.svg).toContain('#mmd-r1-1{fill:#ecede8;}');
    });

    it('embeds the page font and lets labels overflow, so a viewer without the web font does not clip them', () => {
        const font = "@font-face{font-family:'IBM Plex Sans';src:url(data:font/woff2;base64,AAAA)}";
        const root = parseRoot(standaloneSvg(MERMAID_SVG, '#171815', font)!.svg);
        const style = child(root, 'style');
        expect(style.textContent).toBe(`${font}foreignObject{overflow:visible}`);
        expect(child(parseRoot(standaloneSvg(MERMAID_SVG, '#171815')!.svg), 'style').textContent).toBe('foreignObject{overflow:visible}');
    });

    it('rejects markup that is not a usable SVG', () => {
        expect(standaloneSvg('<div>nope</div>', '#000')).toBeNull();
        expect(standaloneSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>', '#000')).toBeNull();
        expect(standaloneSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"></svg>', '#000')).toBeNull();
    });
});

describe('pngScale', () => {
    it('exports at the screen ratio but never below 2×', () => {
        expect(pngScale(400, 300, 1)).toBe(2);
        expect(pngScale(400, 300, 3)).toBe(3);
        expect(pngScale(400, 300, Number.NaN)).toBe(2);
    });

    it('shrinks a huge diagram until the canvas fits every engine', () => {
        const scale = pngScale(6000, 1000, 2);
        expect(6000 * scale).toBeLessThanOrEqual(8192);
        const area = pngScale(4000, 4000, 2);
        expect(4000 * area * 4000 * area).toBeLessThanOrEqual(16_777_216);
    });
});
