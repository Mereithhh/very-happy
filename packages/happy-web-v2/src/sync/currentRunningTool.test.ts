import { describe, expect, it } from 'vitest';
import type { Message } from './typesMessage';
import { currentRunningTool } from './runningTool';

const tool = (id: string, startedAt: number, state: 'running' | 'completed' = 'running') => ({
    kind: 'tool-call', id, localId: null, createdAt: startedAt, children: [],
    tool: { name: 'Bash', state, input: {}, createdAt: startedAt, startedAt, completedAt: null, description: null },
}) as Message;
const user = (id: string, extra: Partial<Message> = {}) => ({ kind: 'user-text', id, localId: null, createdAt: 0, text: id, ...extra }) as Message;

describe('currentRunningTool (live bar elapsed anchor)', () => {
    it('ignores a never-closed tool call from an earlier turn', () => {
        expect(currentRunningTool([user('new'), tool('stale', 1000)])).toBeNull();
    });
    it('takes the newest running tool of the current turn', () => {
        expect(currentRunningTool([tool('b', 50), tool('a', 40), user('u'), tool('stale', 1)])).toEqual({ name: 'Bash', startedAt: 50 });
    });
    it('a queued input or a task notification does not end the current turn', () => {
        expect(currentRunningTool([user('q', { inputState: 'queued' } as Partial<Message>), user('n', { text: '<task-notification><summary>x</summary></task-notification>' } as Partial<Message>), tool('t', 9)]))
            .toEqual({ name: 'Bash', startedAt: 9 });
    });
});
