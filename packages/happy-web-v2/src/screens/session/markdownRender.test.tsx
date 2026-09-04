/**
 * `<Markdown>` 的行为回归（B-354）。
 *
 * 这套测试取代了原来的 `markdownPathWiring.test.ts`。那份测试是**源码断言**，理由写着
 * 「本包没有组件测试基础设施（无 jsdom / testing-library）」——B-309 之后这句话不成立了
 * （`installBrowserTestGlobals` + `renderToStaticMarkup`，先例 `liveStreamRender.test.tsx`）。
 * 换成真渲染测试是严格更强的守卫：它钉的是**行为**，而不是「某个字符串还在源码里」，
 * 因此换引擎、改实现都不会让它假绿或假红。B-145 那三条 finding 逐条保留在下面。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let Markdown: typeof import('./Markdown').Markdown;
let PathLinksScope: typeof import('./Markdown').PathLinksScope;
let NoPathLinks: typeof import('./Markdown').NoPathLinks;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ Markdown, PathLinksScope, NoPathLinks } = await import('./Markdown'));
});

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const md = (text: string, props: Record<string, unknown> = {}) => render(<Markdown text={text} {...props} />);

describe('GFM tables', () => {
    it('renders a table that follows a paragraph with NO blank line (the reported bug)', () => {
        const html = md('结论如下：\n| a | b |\n| --- | --- |\n| 1 | 2 |');
        expect(html).toContain('<table');
        expect(html).toContain('<th>a</th>');
        expect(html).toContain('<td>1</td>');
        // the old renderer swallowed the whole thing into one <p>
        expect(html).not.toContain('| --- |');
    });

    it('honours column alignment', () => {
        const html = md('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
        expect(html).toContain('text-align:left');
        expect(html).toContain('text-align:center');
        expect(html).toContain('text-align:right');
    });

    it('treats an escaped pipe as content, not a column separator', () => {
        const html = md('| a | b |\n| --- | --- |\n| x \\| y | 2 |');
        expect(html).toContain('<td>x | y</td>');
        expect(html.match(/<td/g) ?? []).toHaveLength(2);
    });

    it('pads a short data row to the header width instead of shifting columns', () => {
        const html = md('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |');
        const row = html.slice(html.indexOf('<tbody>'));
        expect(row.match(/<td/g) ?? []).toHaveLength(3);
    });

    it('renders <br> inside a cell as a real line break (how LLMs wrap in tables)', () => {
        const html = md('| a |\n| --- |\n| line1<br>line2 |');
        expect(html).toContain('line1<br/>line2');
        expect(html).not.toContain('&lt;br&gt;');
    });

    it('keeps <br> outside a table as visible text', () => {
        expect(md('talking about <br> tags')).toContain('&lt;br&gt;');
    });

    it('wraps the table in a scroll container', () => {
        expect(md('| a |\n| --- |\n| 1 |')).toContain('md-table-wrap');
    });
});

describe('the rest of GFM the old renderer could not do', () => {
    it('nests lists', () => {
        const html = md('- a\n  - b\n- c');
        expect(html.match(/<ul/g) ?? []).toHaveLength(2);
    });

    it('renders task lists and strikethrough', () => {
        expect(md('- [x] done')).toContain('type="checkbox"');
        expect(md('~~gone~~')).toContain('<del>gone</del>');
    });

    it('autolinks bare URLs and resolves reference links', () => {
        expect(md('see https://example.com/x')).toContain('href="https://example.com/x"');
        expect(md('[a][1]\n\n[1]: https://example.com')).toContain('href="https://example.com"');
    });

    it('does not italicise intra-word underscores', () => {
        expect(md('see foo_bar_baz here')).toContain('foo_bar_baz');
        expect(md('see foo_bar_baz here')).not.toContain('<em>');
    });

    it('keeps a single newline as a visible line break', () => {
        expect(md('line1\nline2')).toContain('<br/>');
    });
});

describe('untrusted content', () => {
    it('escapes raw HTML instead of putting it in the DOM', () => {
        const html = md('<script>alert(1)</script> and <div>x</div>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;div&gt;');
        expect(html).not.toContain('<script>');
    });

    it('never fetches a remote image from agent text', () => {
        const html = md('![alt](https://evil.example/px.png)');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('rel="preload"');
        expect(html).toContain('md-img-chip');
        expect(html).toContain('alt');
    });

    it('renders images for trusted content (the user\'s own .md file)', () => {
        const html = md('![alt](https://example.com/a.png)', { trustContent: true });
        expect(html).toContain('<img');
        expect(html).toContain('src="https://example.com/a.png"');
    });

    it('blanks out links whose scheme is not on the whitelist', () => {
        expect(md('[x](javascript:alert(1))')).toContain('href=""');
        expect(md('[x](tel:+15551234)')).toContain('href=""');
        expect(md('[x](https://example.com)')).toContain('href="https://example.com"');
    });
});

describe('options blocks', () => {
    it('renders clickable buttons and keeps the prose', () => {
        const html = md('选哪个？\n<options>\n<option>甲</option>\n<option>乙</option>\n</options>', { onOption: () => {} });
        expect(html).toContain('md-option--clickable');
        expect(html).toContain('甲');
        expect(html).toContain('选哪个？');
        expect(html).not.toContain('&lt;options&gt;');
    });

    it('renders a non-clickable option when no handler is supplied', () => {
        const html = md('q\n<options>\n<option>甲</option>\n</options>');
        expect(html).toContain('md-option');
        expect(html).not.toContain('md-option--clickable');
    });

    it('leaves a fenced example alone', () => {
        const html = md('像这样：\n```\n<options>\n<option>a</option>\n</options>\n```', { onOption: () => {} });
        expect(html).not.toContain('md-option');
        expect(html).toContain('&lt;options&gt;');
    });
});

describe('code blocks', () => {
    it('hands fenced code to CodeView with its language', () => {
        const html = md('```ts\nconst a = 1;\n```');
        expect(html).toContain('const a = 1;');
        expect(html).toContain('code');       // CodeView markup, not a bare <pre><code>
        expect(html).not.toContain('```');
    });

    it('keeps an inline span inline', () => {
        expect(md('use `npm i` now')).toContain('md-code-inline');
    });
});

/* ── B-145: path links ──────────────────────────────────────────────────── */

/**
 * 白名单直接注入（`PathLinksScope`），不走 store：vitest 在 node 环境里跑，
 * `renderToStaticMarkup` 读的是 zustand 的 SSR 快照（= 初始 state），store 里塞什么
 * 都读不到（`liveStreamRender.test.tsx` 记过同一件事）。同理 `FilePathLink` 拿不到
 * `machineId`，会降级成 `<span class="md-path">`——这里断言的正是「路径被切成了自己的
 * 节点」这个接线事实，与它最终渲染成 button 还是 span 无关。
 */
function withPaths(paths: string[], node: React.ReactNode) {
    return render(<PathLinksScope sessionId="s1" allowlist={new Set(paths)}>{node}</PathLinksScope>);
}

describe('file-path links (B-145)', () => {
    it('finding 1: a path inside an inline code span is picked up', () => {
        const html = withPaths(['docs/report.md'], <Markdown text="已写入 `docs/report.md`" />);
        expect(html).toContain('md-code-inline');
        expect(html).toContain('md-path');
    });

    it('links a path in plain prose and inside emphasis', () => {
        const html = withPaths(['docs/report.md'], <Markdown text="see docs/report.md and **docs/report.md**" />);
        expect(html.match(/md-path/g) ?? []).toHaveLength(2);
    });

    it('links a path inside a table cell', () => {
        const html = withPaths(['docs/report.md'], <Markdown text={'| f |\n| --- |\n| docs/report.md |'} />);
        expect(html).toContain('md-path');
    });

    it('finding 3: never puts the path node inside a markdown link label', () => {
        const html = withPaths(['docs/report.md'], <Markdown text="[docs/report.md](https://example.com)" />);
        const anchor = html.slice(html.indexOf('<a '), html.indexOf('</a>'));
        expect(anchor).not.toContain('md-path');
        expect(anchor).toContain('docs/report.md');
    });

    it('NoPathLinks turns the whole subtree off (streaming drafts)', () => {
        const html = withPaths(['docs/report.md'], <NoPathLinks><Markdown text="see docs/report.md" /></NoPathLinks>);
        expect(html).not.toContain('md-path');
    });

    it('a path that no tool touched stays plain text', () => {
        const html = withPaths(['docs/report.md'], <Markdown text="see package.json" />);
        expect(html).not.toContain('md-path');
    });

    it('code blocks are not scanned for paths (CodeView owns that subtree)', () => {
        const html = withPaths(['docs/report.md'], <Markdown text={'```\nsee docs/report.md\n```'} />);
        expect(html).not.toContain('md-path');
    });
});

describe('rehypeTextLeaves', () => {
    it('does not wrap the whitespace hast keeps between table rows', () => {
        // Wrapping those produced invalid nesting: React logs "whitespace text
        // nodes cannot be a child of <table>" once per row in a real browser.
        // renderToStaticMarkup does not warn, so this is asserted structurally.
        const html = md('| a | b |\n| --- | --- |\n| 1 | 2 |');
        expect(html).not.toMatch(/<table[^>]*>\s*<vh-text/);
        expect(html).not.toMatch(/<thead[^>]*>\s*<vh-text/);
        expect(html).not.toMatch(/<tr[^>]*>\s*<vh-text/);
        expect(html).not.toMatch(/<tbody[^>]*>\s*<vh-text/);
    });
});

describe('table cell line breaks reach nested marks', () => {
    it('splits <br> inside bold text (bold + break is a common table shape)', () => {
        const html = md('| a |\n| --- |\n| **line1<br>line2** |');
        expect(html).toContain('<strong>line1<br/>line2</strong>');
    });
});

describe('a <br> inside an inline code span stays literal', () => {
    it('matches GitHub: code spans are content, not markup', () => {
        const html = md('| a |\n| --- |\n| `x<br>y` |');
        expect(html).toContain('&lt;br&gt;');
        expect(html).not.toContain('<code class="md-code-inline">x<br/>y</code>');
    });
});
