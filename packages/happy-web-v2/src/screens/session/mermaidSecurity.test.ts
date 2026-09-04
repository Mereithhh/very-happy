// @vitest-environment happy-dom
/**
 * mermaid 产物的注入防线（B-358）。
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

/**
 * happy-dom 没有 SVG 排版引擎，`getBBox` 之类只能 stub —— **flowchart 能跑到底，
 * 其它图类型（实测 sequenceDiagram）会抛 `svg element not in render tree`**，
 * 在这里只会得到 `reason: 'render'`。所以「sequence / gantt 也能出图」这类覆盖
 * 只有浏览器验收一处证据，CI 挡不住它坏掉——别以为这个文件覆盖到了。
 */
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

    /**
     * 断言在 **DOM 层**，不是字符串层。
     *
     * 第一版写的是 `svg.not.toContain('onerror')`——实测那是错的层次：单独喂
     * `A["<img src=x onerror=alert(2)>"]` 时，字符串里**确实**留着 `onerror` 三个字
     * （作为被转义的文本），但把 SVG 注进 DOM 后活的 `<img>` 与 `on*` 属性都是 0。
     * 也就是说字符串断言既会假红（安全却报警），又不覆盖真正的失败模式（活处理器）。
     */
    const hostile: Array<[string, string]> = [
        ['script tag', 'graph TD;\n  A["<script>alert(1)</script>"] --> B[ok];'],
        ['img onerror', 'graph TD;\n  A["<img src=x onerror=alert(2)>"] --> B[ok];'],
        ['click handler', 'graph TD;\n  A[ok] --> B[ok];\n  click A "javascript:alert(3)"'],
        ['svg onload', 'graph TD;\n  A["<svg onload=alert(4)>"] --> B[ok];'],
        ['classDef url', 'graph TD;\n  A[ok];\n  classDef evil fill:url(javascript:alert(5));\n  class A evil;'],
    ];

    it.each(hostile)('never lets %s become a live node or handler', async (_name, source) => {
        const out = await renderMermaid(`mmd-xss-${Math.random().toString(36).slice(2, 8)}`, source, 'dark');
        if (!out.ok) { expect(['syntax', 'render']).toContain(out.reason); return; }
        const host = document.createElement('div');
        host.innerHTML = out.svg;
        expect(host.querySelectorAll('script')).toHaveLength(0);
        expect(host.querySelectorAll('img')).toHaveLength(0);
        expect(host.querySelectorAll('iframe')).toHaveLength(0);
        const withHandlers = [...host.querySelectorAll('*')].filter((el) =>
            [...el.attributes].some((a) => a.name.toLowerCase().startsWith('on')));
        expect(withHandlers.map((el) => el.tagName)).toEqual([]);
        const hrefs = [...host.querySelectorAll('*')].flatMap((el) =>
            [...el.attributes].filter((a) => /href|src/i.test(a.name)).map((a) => a.value.toLowerCase()));
        expect(hrefs.filter((h) => h.startsWith('javascript:'))).toEqual([]);
    }, 30_000);
});
