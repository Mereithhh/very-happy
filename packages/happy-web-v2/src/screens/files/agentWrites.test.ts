import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { changeAction, isNewWrite, lastAgentWriteAt, normalizeAbsPath, QUIET_MS } from './agentWrites';

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
    it('expands ~ with the session home when known (review 低5)', () => {
        expect(normalizeAbsPath('~/proj/a.ts', '/repo', '/Users/u/')).toBe('/Users/u/proj/a.ts');
        expect(normalizeAbsPath('~', '/repo', '/Users/u')).toBe('/Users/u');
        expect(normalizeAbsPath('~other/a', '/repo', '/Users/u')).toBe('~other/a')   // only `~` / `~/` are this user's home;
    });
});

describe('lastAgentWriteAt', () => {
    const cwd = '/repo';
    it('is the latest completed write to the same (normalized) path; others do not count', () => {
        const base: Message[] = [tool('Read', { file_path: '/repo/a.ts' }), tool('Edit', { file_path: '/repo/b.ts', old_string: 'a', new_string: 'b' })];
        expect(lastAgentWriteAt(base, '/repo/a.ts', cwd)).toBe(0);
        expect(lastAgentWriteAt([...base, tool('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 200)], '/repo/a.ts', cwd)).toBe(200);
        expect(lastAgentWriteAt([...base, tool('Write', { file_path: '/repo/a.ts', content: 'x' }, null, 'running')], '/repo/a.ts', cwd)).toBe(0);
        expect(lastAgentWriteAt([...base, tool('Write', { file_path: '/repo/a.ts', content: 'x' }, 300, 'error')], '/repo/a.ts', cwd)).toBe(0);
        expect(lastAgentWriteAt([tool('Write', { file_path: '~/repo/a.ts', content: 'x' }, 400)], '/Users/u/repo/a.ts', cwd, '/Users/u')).toBe(400);
    });
    it('older history pages arriving later never look like a new write (review 中2)', () => {
        const recent = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, 500);
        const readAt = 600;
        const before = lastAgentWriteAt([recent], '/repo/a.ts', cwd);
        const withOlderPage = lastAgentWriteAt([recent, tool('Write', { file_path: '/repo/a.ts', content: 'x' }, 100)], '/repo/a.ts', cwd);
        expect(withOlderPage).toBe(before);
        expect(isNewWrite(withOlderPage, readAt)).toBe(false);
        // a first load of a session whose last write predates opening the file: not news either
        expect(isNewWrite(500, readAt)).toBe(false);
        expect(isNewWrite(700, readAt)).toBe(true);
    });
    it('covers Codex patches (incl. moves), pi writes and sub-agent children', () => {
        const codex = tool('CodexPatch', { changes: { '/repo/a.ts': { kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' } } }, 300);
        expect(lastAgentWriteAt([codex], '/repo/a.ts', cwd)).toBe(300);
        const moved = tool('CodexPatch', { changes: { '/repo/old.ts': { kind: { type: 'update', move_path: '/repo/a.ts' } } } }, 310);
        expect(lastAgentWriteAt([moved], '/repo/a.ts', cwd)).toBe(310);
        const pi = tool('edit', { piTool: 'write', rawInput: { path: './a.ts', content: 'x' } }, 320);
        expect(lastAgentWriteAt([pi], '/repo/a.ts', cwd)).toBe(320);
        const card = tool('Task', { prompt: 'p' });
        if (card.kind === 'tool-call') card.children = [tool('Write', { file_path: '/repo/a.ts', content: 'x' }, 330)];
        expect(lastAgentWriteAt([card], '/repo/a.ts', cwd)).toBe(330);
    });
    it('caches per message object, keyed by cwd/home', () => {
        const m = tool('Write', { file_path: 'a.ts', content: 'x' }, 50);
        expect(lastAgentWriteAt([m], '/repo/a.ts', '/repo')).toBe(50);
        expect(lastAgentWriteAt([m], '/other/a.ts', '/other')).toBe(50);   // different cwd → recomputed, not a stale hit
        expect(lastAgentWriteAt([m], '/repo/a.ts', '/other')).toBe(0);
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
