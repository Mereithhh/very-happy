import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import {
    collectSessionFilePaths,
    findPathHits,
    resolveAgainstCwd,
    toolFilePathOf,
} from './toolFilePath';

const tool = (name: string, input: Record<string, unknown>): ToolCall =>
    ({ name, input, state: 'completed' } as unknown as ToolCall);

describe('toolFilePathOf', () => {
    it('抽取 file_path', () => {
        expect(toolFilePathOf(tool('Write', { file_path: 'docs/a.md' }))).toBe('docs/a.md');
        expect(toolFilePathOf(tool('Read', { file_path: '/abs/b.ts' }))).toBe('/abs/b.ts');
    });

    it('回落到 locations[0].path（某些变体的形状）', () => {
        expect(toolFilePathOf(tool('Edit', { locations: [{ path: 'x/y.md' }] }))).toBe('x/y.md');
    });

    it('不带路径的工具一律 null（Bash 的 command 不是路径）', () => {
        expect(toolFilePathOf(tool('Bash', { command: 'cat docs/a.md' }))).toBeNull();
    });

    it('sees through pi read/write args (B-353)', () => {
        expect(toolFilePathOf(tool('read', { piTool: 'read', rawInput: { path: 'src/a.ts' } }))).toBe('src/a.ts');
        expect(toolFilePathOf(tool('edit', { piTool: 'write', rawInput: { path: '/w/b.md', content: '' } }))).toBe('/w/b.md');
        expect(toolFilePathOf(tool('execute', { piTool: 'bash', command: 'cat src/a.ts' }))).toBeNull();
        expect(toolFilePathOf(tool('Grep', { pattern: 'foo' }))).toBeNull();
        expect(toolFilePathOf(tool('Write', {}))).toBeNull();
        expect(toolFilePathOf(tool('Write', { file_path: '   ' }))).toBeNull();
    });
});

describe('collectSessionFilePaths', () => {
    it('只从 tool-call 消息里收，去重', () => {
        const messages = [
            { kind: 'tool-call', tool: tool('Write', { file_path: 'a.md' }) },
            { kind: 'tool-call', tool: tool('Read', { file_path: 'a.md' }) },
            { kind: 'tool-call', tool: tool('Read', { file_path: 'b.ts' }) },
            { kind: 'tool-call', tool: tool('Bash', { command: 'ls' }) },
            { kind: 'agent-text', text: 'see c.md' },
        ] as unknown as Message[];
        expect([...collectSessionFilePaths(messages)].sort()).toEqual(['a.md', 'b.ts']);
    });
});

describe('resolveAgainstCwd', () => {
    it('相对路径拼 cwd，绝对路径与 ~ 原样', () => {
        expect(resolveAgainstCwd('docs/a.md', '/repo')).toBe('/repo/docs/a.md');
        expect(resolveAgainstCwd('./docs/a.md', '/repo/')).toBe('/repo/docs/a.md');
        expect(resolveAgainstCwd('/abs/a.md', '/repo')).toBe('/abs/a.md');
        expect(resolveAgainstCwd('~/a.md', '/repo')).toBe('~/a.md');
    });

    it('没有 cwd 时原样交给 daemon（让它报 not-found，别猜）', () => {
        expect(resolveAgainstCwd('docs/a.md', null)).toBe('docs/a.md');
    });
});

describe('findPathHits — 白名单匹配', () => {
    const allow = new Set(['docs/report.md', 'report.md', 'src/index.ts']);

    it('命中白名单里的路径', () => {
        const hits = findPathHits('已写入 docs/report.md 请查看', allow);
        expect(hits).toHaveLength(1);
        expect(hits[0].path).toBe('docs/report.md');
    });

    it('长路径优先，不把 docs/report.md 切碎成 report.md', () => {
        const hits = findPathHits('see docs/report.md', allow);
        expect(hits.map((h) => h.path)).toEqual(['docs/report.md']);
    });

    it('不在白名单的路径不命中（这是本设计的核心——不猜）', () => {
        expect(findPathHits('改了 package.json 和 a/b/c.py', allow)).toHaveLength(0);
    });

    it('要求路径字符边界，避免命中到更长 token 的中间', () => {
        expect(findPathHits('xdocs/report.mdy', allow)).toHaveLength(0);
        expect(findPathHits('prefix-report.md', allow)).toHaveLength(0);
    });

    it('同一路径多次出现都命中，按位置排序且不重叠', () => {
        const hits = findPathHits('report.md 然后 report.md', new Set(['report.md']));
        expect(hits).toHaveLength(2);
        expect(hits[0].start).toBeLessThan(hits[1].start);
        expect(hits[0].end).toBeLessThanOrEqual(hits[1].start);
    });

    it('空白名单 / 空文本直接返回空', () => {
        expect(findPathHits('docs/report.md', new Set())).toHaveLength(0);
        expect(findPathHits('', allow)).toHaveLength(0);
    });
});
