import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { agentWriteSignature, changeAction, normalizeAbsPath, QUIET_MS } from './agentWrites';

let n = 0;
const tool = (name: string, input: unknown, completedAt: number | null = 100, state: ToolCall['state'] = 'completed'): Message => ({
    kind: 'tool-call', id: `t${++n}`, localId: null, createdAt: 50, children: [],
    tool: { name, input, state, createdAt: 50, startedAt: 50, completedAt, description: null },
});

describe('normalizeAbsPath', () => {
    it('resolves against the cwd and folds . / .. / //', () => {
        expect(normalizeAbsPath('src/../src/./a.ts', '/repo')).toBe('/repo/src/a.ts');
        expect(normalizeAbsPath('/repo//src/a.ts', '/x')).toBe('/repo/src/a.ts');
        expect(normalizeAbsPath('../up.md', '/repo/sub')).toBe('/repo/up.md');
        expect(normalizeAbsPath('~/n.md', '/repo')).toBe('~/n.md');
    });
});

describe('agentWriteSignature', () => {
    const cwd = '/repo';
    it('moves only for completed writes to the same (normalized) path', () => {
        const base: Message[] = [tool('Read', { file_path: '/repo/a.ts' }), tool('Edit', { file_path: '/repo/b.ts', old_string: 'a', new_string: 'b' })];
        const before = agentWriteSignature(base, '/repo/a.ts', cwd);
        expect(before).toBe('0:0');
        expect(agentWriteSignature([...base, tool('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 200)], '/repo/a.ts', cwd)).toBe('1:200');
        expect(agentWriteSignature([...base, tool('Write', { file_path: '/repo/a.ts', content: 'x' }, null, 'running')], '/repo/a.ts', cwd)).toBe(before);
        expect(agentWriteSignature([...base, tool('Write', { file_path: '/repo/a.ts', content: 'x' }, 300, 'error')], '/repo/a.ts', cwd)).toBe(before);
    });
    it('covers Codex patches (incl. moves), pi writes and sub-agent children', () => {
        const codex = tool('CodexPatch', { changes: { '/repo/a.ts': { kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' } } }, 300);
        expect(agentWriteSignature([codex], '/repo/a.ts', cwd)).toBe('1:300');
        const moved = tool('CodexPatch', { changes: { '/repo/old.ts': { kind: { type: 'update', move_path: '/repo/a.ts' } } } }, 310);
        expect(agentWriteSignature([moved], '/repo/a.ts', cwd)).toBe('1:310');
        const pi = tool('edit', { piTool: 'write', rawInput: { path: './a.ts', content: 'x' } }, 320);
        expect(agentWriteSignature([pi], '/repo/a.ts', cwd)).toBe('1:320');
        const card = tool('Task', { prompt: 'p' });
        if (card.kind === 'tool-call') card.children = [tool('Write', { file_path: '/repo/a.ts', content: 'x' }, 330)];
        expect(agentWriteSignature([card], '/repo/a.ts', cwd)).toBe('1:330');
    });
});

describe('changeAction', () => {
    const quiet = { phase: 'text', kind: 'code', visible: true, hasSelection: false, msSinceInteraction: QUIET_MS + 1 };
    it('refreshes silently only when the user is not mid-reading', () => {
        expect(changeAction(quiet)).toBe('silent');
        expect(changeAction({ ...quiet, hasSelection: true })).toBe('banner');
        expect(changeAction({ ...quiet, msSinceInteraction: 200 })).toBe('banner');
        expect(changeAction({ ...quiet, visible: false })).toBe('banner');
    });
    it('non-text previews ask first; an in-flight load just reloads', () => {
        expect(changeAction({ ...quiet, kind: 'html' })).toBe('banner');
        expect(changeAction({ ...quiet, phase: 'bytes', kind: 'image' })).toBe('banner');
        expect(changeAction({ ...quiet, phase: 'loading' })).toBe('reload');
    });
});
