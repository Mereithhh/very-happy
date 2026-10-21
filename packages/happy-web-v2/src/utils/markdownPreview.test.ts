import { describe, expect, it } from 'vitest';
import { plainMarkdownLines, plainPreviewLines, plainPreviewText } from './markdownPreview';

/** Bare markdown syntax a preview must never show (B-716). */
const BARE = /\*\*|^#{1,6}\s|\|\s*-{3,}|-{3,}\s*\||```|^\s*[-*+]\s|\]\(/m;

const SUBMIT = [
    '## B-716 交付',
    '',
    '**PR #700** 已绿，改动如下：',
    '',
    '| 项 | 状态 |',
    '|---|:---:|',
    '| 卡片预览 | ✅ |',
    '| 浮层 | ✅ |',
    '',
    '- 证据见 [截图](https://example.com/a.png)',
    '1. `pnpm exec tsc --noEmit` 退出码 0',
    '',
    '```sh',
    'pnpm -C packages/happy-web-v2 exec vitest run',
    '```',
    '> 备注：~~旧方案~~ 已弃用',
].join('\n');

describe('markdown preview (B-716)', () => {
    it('keeps one plain line per source line, with no markdown syntax left', () => {
        const lines = plainMarkdownLines(SUBMIT);
        expect(lines).toEqual([
            'B-716 交付',
            'PR #700 已绿，改动如下：',
            '项 状态',
            '卡片预览 ✅',
            '浮层 ✅',
            '证据见 截图',
            'pnpm exec tsc --noEmit 退出码 0',
            '[code]',
            '备注：旧方案 已弃用',
        ]);
        for (const line of lines) expect(line).not.toMatch(BARE);
    });

    it('drops separator rows without a trailing pipe too', () => {
        expect(plainMarkdownLines('a | b\n---|---\n1 | 2')).toEqual(['a b', '1 2']);
    });

    it('caps the folded preview at N lines and reports truncation', () => {
        expect(plainPreviewLines(SUBMIT, 3)).toEqual({ lines: ['B-716 交付', 'PR #700 已绿，改动如下：', '项 状态'], truncated: true });
        expect(plainPreviewLines('one\ntwo', 3)).toEqual({ lines: ['one', 'two'], truncated: false });
        expect(plainPreviewLines('x'.repeat(50), 3, 10)).toEqual({ lines: [`${'x'.repeat(9)}…`], truncated: true });
    });

    it('one-line form joins the plain lines', () => {
        expect(plainPreviewText('# T\n\n- **a**\n- b')).toBe('T a b');
    });
});
