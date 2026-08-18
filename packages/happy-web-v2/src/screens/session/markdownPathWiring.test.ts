/**
 * B-145 finding 1 的回归守卫：路径链接必须接进**所有**承载纯文本的分支。
 *
 * 事故经过：第一版只把 `TextLeaf` 挂在 `renderBoldItalic` 的纯文本上，而
 * `renderInline` 会先把行内代码段切出来直接输出 `<code>{原文}</code>`。claude 写
 * 文件路径的**默认形式恰恰是反引号**（「已写入 `docs/report.md`」），于是功能在它
 * 最主要的场景下完全不生效——而当时 12 条纯函数测试全绿，因为它们只验了
 * `findPathHits` 的匹配逻辑，没有一条验「这个逻辑被接到了正确的地方」。
 *
 * 为什么是**结构断言**而不是渲染测试：本包没有组件测试基础设施（无 jsdom /
 * testing-library，全项目都是纯函数测试）。为一条回归引入一整套渲染栈不划算，
 * 而这次坏掉的恰好是「接线」这个结构性质，用源码断言钉得住。手法同 B-130 的
 * 「三处工具描述同源」守卫。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(__dirname, 'Markdown.tsx'), 'utf8');

describe('Markdown 的路径链接接线', () => {
    it('行内代码段的内容必须过 TextLeaf（这就是 finding 1 坏掉的地方）', () => {
        // 找到代码段分支，断言它渲染 TextLeaf 而不是直接吐原文
        const branch = SRC.slice(SRC.indexOf("part.startsWith('`')"));
        const codeTag = branch.slice(0, branch.indexOf('</code>'));
        expect(codeTag, '代码段分支必须用 <TextLeaf>，否则反引号里的路径不可点').toContain('<TextLeaf');
        // 坏形式是把原文作为 <code> 的**直接子节点**：`>{part.slice(1, -1)}<`
        expect(codeTag, '不能再把原文直接作为 <code> 的子节点').not.toMatch(/>\s*\{\s*part\.slice\(1,\s*-1\)\s*\}/);
    });

    it('强调（粗体/斜体）里的纯文本也走 TextLeaf', () => {
        // renderBoldItalic 的两处纯文本推入点都必须是 TextLeaf
        const fn = SRC.slice(SRC.indexOf('function renderBoldItalic'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        const leaves = body.match(/<TextLeaf\b/g) ?? [];
        expect(leaves.length, '应有两处纯文本推入（中段与尾段），都用 TextLeaf').toBe(2);
        // 裸字符串推入 = 没过 TextLeaf，就是 finding 1 的形状
        expect(body).not.toMatch(/nodes\.push\(text\.slice\(/);
    });

    it('markdown 链接的 label 里必须禁用路径链接（finding 3：button 不能嵌 a）', () => {
        const anchor = SRC.slice(SRC.indexOf('className="md-link"'));
        const tag = anchor.slice(0, anchor.indexOf('</a>'));
        expect(tag, 'label 必须包在 NoPathLinks 里').toContain('<NoPathLinks>');
    });

    it('provider 必须是导出的会话级组件，Markdown 自己不再订阅消息（finding 2）', () => {
        expect(SRC).toContain('export function MarkdownPathProvider');
        // Markdown 组件体内不得再出现 useSessionMessages —— 那是 O(N²) 的成因
        const comp = SRC.slice(SRC.indexOf('export function Markdown('));
        expect(comp.slice(0, comp.indexOf('\n}'))).not.toContain('useSessionMessages');
    });
});
