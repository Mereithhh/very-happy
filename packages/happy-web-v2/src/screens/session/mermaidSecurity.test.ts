// @vitest-environment happy-dom
/**
 * mermaid 产物的注入防线（B-357）。
 *
 * `MermaidView` 用 `dangerouslySetInnerHTML` 注入 mermaid 返回的 SVG——这是本仓第二处
 * （第一处是 shiki）。它之所以可以接受，全靠 `securityLevel: 'strict'`（禁 click 处理器与
 * 原始 HTML 标签）加 mermaid 内部的 dompurify；那两条如果哪天被改掉，这里必须变红。
 *
 * **为什么这个文件要单独切 happy-dom 环境**：本包的 vitest 跑在 node 下，而
 * `mermaid.render` 实测抛 `document is not defined`（`parse` 不需要 DOM，`render` 需要）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderMermaid, resetMermaidForTest, sanitizeMermaidId } from './mermaidRender';

beforeAll(() => {
    resetMermaidForTest();
    // happy-dom has no SVG layout engine, and mermaid measures every label with
    // getBBox/getComputedTextLength. Stub them so the pipeline runs to the end —
    // the geometry is meaningless here, the SERIALISED OUTPUT is what we assert on.
    const proto = (globalThis as unknown as { SVGElement: { prototype: Record<string, unknown> } }).SVGElement.prototype;
    proto.getBBox = () => ({ x: 0, y: 0, width: 80, height: 16 });
    proto.getComputedTextLength = () => 80;
    proto.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => ({}) });
});

describe('sanitizeMermaidId', () => {
    it('strips what React 19 useId() produces (mermaid feeds the id to querySelector)', () => {
        expect(sanitizeMermaidId('«r1»')).toBe('mmd-r1');
        expect(sanitizeMermaidId(':r7:')).toBe('mmd-r7');
        expect(sanitizeMermaidId('')).toBe('mmd-0');
        expect(sanitizeMermaidId('a-b_c')).toBe('mmd-a-b_c');
    });
});

describe('renderMermaid', () => {
    it('renders a valid diagram to drawable SVG content', async () => {
        const out = await renderMermaid('mmd-ok', 'graph TD;\nA-->B;', 'dark');
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        // happy-dom serialises the SVG root differently from a browser (no literal
        // `<svg` in the string), so assert on the drawing content instead; the real
        // `<svg>` element is covered by the browser check in the release notes.
        for (const marker of ['<g ', '<path', 'viewBox']) expect(out.svg).toContain(marker);
        expect(out.svg.length).toBeGreaterThan(1000);
    }, 30_000);

    it('reports bad syntax instead of throwing or emitting mermaid’s own error diagram', async () => {
        const out = await renderMermaid('mmd-bad', 'graph TD;\n this is not mermaid at all ((', 'dark');
        expect(out).toEqual({ ok: false, reason: 'syntax' });
    }, 30_000);

    it('never lets a script or an event handler through', async () => {
        const hostile = [
            'graph TD;',
            '  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(2)>"];',
            '  click A "javascript:alert(3)"',
        ].join('\n');
        const out = await renderMermaid('mmd-xss', hostile, 'dark');
        // Either it refuses to parse, or the SVG it produces carries none of it.
        if (out.ok) {
            expect(out.svg).not.toContain('<script');
            expect(out.svg).not.toContain('onerror');
            expect(out.svg.toLowerCase()).not.toContain('javascript:');
        } else {
            expect(out.reason).toBe('syntax');
        }
    }, 30_000);
});
