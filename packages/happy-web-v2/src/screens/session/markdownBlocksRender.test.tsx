/**
 * B-610: streaming `<Markdown>` renders block by block; the markup must be
 * byte-identical to rendering the whole document — at EVERY prefix of the
 * stream, because that is what the user sees while it arrives.
 *
 * Real-transcript sweep (not in CI — the corpus is local):
 *   VH_MD_CORPUS=/path/to/samples.json pnpm exec vitest run markdownBlocksRender
 * where samples.json is a JSON array of assistant text blocks.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { splitMarkdownBlocks } from './markdownBlocks';

let Markdown: typeof import('./Markdown').Markdown;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ Markdown } = await import('./Markdown'));
});

// `useId` values encode the fiber's tree position, which block wrappers change.
// They only pair a disclosure button with its panel inside one component, so
// normalise them; everything else must match byte for byte.
const render = (text: string, streaming: boolean) =>
    renderToStaticMarkup(<MemoryRouter><Markdown text={text} plainCode streaming={streaming} /></MemoryRouter>)
        .replace(/_R_[0-9a-zA-Z]+_/g, '_R_id_');

export const FIXTURES: Record<string, string> = {
    prose: '# Heading\n\nFirst paragraph with **bold** and `code`.\nSoft break line.\n\nSecond _para_ https://example.com.\n\n---\n\nTail',
    fences: 'Intro:\n\n```ts\nconst a = 1;\n\n// blank above\n```\n\n~~~\n```\nnot closed by backticks\n\n~~~\n\nAfter **fence**.\n\n```\nunclosed\n\nstill code',
    looseList: 'Steps:\n\n1. first\n\n2. second\n\n   continued para\n\n3. third\n\nDone.\n\n- a\n- b\n\n  - nested\n\n- c\n\nEnd',
    listFence: 'Run this:\n\n1. Install:\n   ```bash\n   pnpm i\n\n   pnpm build\n   ```\n\n2. Then:\n\n   ```\n   go\n   ```\n\nAfterwards check.',
    ambiguousFence: 'p\n\n1. ```\n  cmd\n   ```\n\nx\n\n```\ny\n\nz\n```\n\nw',
    tables: '结论如下：\n| a | b |\n| --- | :-: |\n| 1 | x \\| y |\n| 2 |\n\nNext table:\n\n| c |\n|---|\n| 3 |\n\nend',
    quotes: '> quoted\nlazy line\n\n> second quote\n> > nested\n\nTitle\n=====\n\nSub\n---\n\ntext',
    html: '<!--\ncomment\n\nstill\n-->\n\n<div>\nraw\n\nafter <b>inline</b>\n\n<pre>\na\n\nb\n</pre>\n\nend',
    htmlFence: '<details>\n```\n\nx\n```\n\ny',
    refs: 'See [docs][d] and note[^1].\n\nMore.\n\n[d]: https://example.com\n[^1]: footnote text',
    tasks: '- [ ] todo\n- [x] done\n\n~~strike~~ and foo_bar_baz\n\n* * *\n\n+ plus\n\n+ loose plus',
    indented: 'para\n\n    indented code\n\n    more\n\nafter\n\n\tTabbed\n\nend',
    crlf: 'a\r\n\r\n```\r\nx\r\n\r\ny\r\n```\r\n\r\nb\r\n',
    cjk: '## 总结\n\n- 第一点：**重要**\n- 第二点\n\n> 引用\n\n| 列 | 值 |\n|---|---|\n| 甲 | 1 |\n\n结束。',
};

function prefixes(text: string, step: number): string[] {
    const out: string[] = [];
    for (let i = 1; i <= text.length; i += step) out.push(text.slice(0, i));
    out.push(text);
    return out;
}

describe('B-610 block-wise streaming render is identical to whole-document render', () => {
    for (const [name, text] of Object.entries(FIXTURES)) {
        it(`${name}: every prefix`, () => {
            for (const prefix of prefixes(text, 1)) {
                expect(render(prefix, true), JSON.stringify(prefix)).toBe(render(prefix, false));
            }
        });
    }

    it('actually splits (the equivalence above is not vacuous)', () => {
        expect(splitMarkdownBlocks(FIXTURES.prose).length).toBeGreaterThan(3);
        expect(splitMarkdownBlocks(FIXTURES.listFence).length).toBeGreaterThan(2);
        expect(render(FIXTURES.prose, true)).toContain('<h1>Heading</h1>\n<p>');
    });

    const corpus = process.env.VH_MD_CORPUS;
    it.skipIf(!corpus)('real transcript corpus (VH_MD_CORPUS)', () => {
        const samples = JSON.parse(readFileSync(corpus!, 'utf8')) as string[];
        let blocks = 0;
        for (const sample of samples) {
            blocks += splitMarkdownBlocks(sample).length;
            for (const prefix of prefixes(sample, Math.max(1, Math.floor(sample.length / 12)))) {
                expect(render(prefix, true), JSON.stringify(prefix.slice(0, 200))).toBe(render(prefix, false));
            }
        }
        console.log(`[B-610 corpus] ${samples.length} samples, ${blocks} blocks`);
    }, 600_000);
});
