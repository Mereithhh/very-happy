import { describe, expect, it } from 'vitest';
import { CODEX_HELPER_LABEL_MAX_CHARS, codexAgentPathSegments, codexChildAnnouncements, codexHelperLabel } from './codexChildThreads';

describe('codexHelperLabel (B-628)', () => {
    it('collapses the prompt onto one line and clips long ones', () => {
        expect(codexHelperLabel('  Find every\n\n  caller of foo  ')).toBe('Find every caller of foo');
        const long = 'x'.repeat(200);
        const label = codexHelperLabel(long)!;
        expect(label.length).toBe(CODEX_HELPER_LABEL_MAX_CHARS);
        expect(label.endsWith('…')).toBe(true);
    });

    it('never ends on half a surrogate pair', () => {
        const prompt = `${'a'.repeat(CODEX_HELPER_LABEL_MAX_CHARS - 2)}😀zzz`;
        const label = codexHelperLabel(prompt)!;
        expect(label).toBe(`${'a'.repeat(CODEX_HELPER_LABEL_MAX_CHARS - 2)}…`);
    });

    it('is null for no prompt', () => {
        expect(codexHelperLabel(undefined)).toBeNull();
        expect(codexHelperLabel('   ')).toBeNull();
    });
});

describe('codexChildAnnouncements (B-628)', () => {
    it('names a spawned helper by its prompt head, once per receiver', () => {
        expect(codexChildAnnouncements({
            type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'completed',
            receiverThreadIds: ['thread-child-1', 'thread-child-1'], prompt: 'List the repo\nthen report',
        })).toEqual([{ threadId: 'thread-child-1', label: 'List the repo then report' }]);
    });

    it('a later call to a helper does not rename it', () => {
        expect(codexChildAnnouncements({
            type: 'collabAgentToolCall', id: 'c2', tool: 'sendInput', receiverThreadIds: ['thread-child-1'], prompt: 'now do X',
        })).toEqual([{ threadId: 'thread-child-1', label: null }]);
    });

    it('reads subAgentActivity by its agentPath leaf and skips the tree root', () => {
        expect(codexChildAnnouncements({ type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: 'thread-child-2', agentPath: '/root/list_directory' }))
            .toEqual([{ threadId: 'thread-child-2', label: 'list_directory' }]);
        expect(codexChildAnnouncements({ type: 'subAgentActivity', id: 's2', kind: 'started', agentThreadId: 'thread-own', agentPath: '/root/' })).toEqual([]);
        expect(codexChildAnnouncements({ type: 'subAgentActivity', id: 's3', kind: 'started', agentThreadId: 'thread-child-3' }))
            .toEqual([{ threadId: 'thread-child-3', label: null }]);
        expect(codexAgentPathSegments('/root//list_directory/')).toEqual(['root', 'list_directory']);
    });

    it('ignores other items', () => {
        expect(codexChildAnnouncements({ type: 'commandExecution', id: 'x' })).toEqual([]);
    });
});
