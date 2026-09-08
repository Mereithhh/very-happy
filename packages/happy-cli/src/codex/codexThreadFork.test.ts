import { describe, expect, it, vi } from 'vitest';

import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    forkCodexBeforeUserMessage,
    listCodexRewindPoints,
} from './codexThreadFork';

const threadWithTurns = {
    id: 'thread-source',
    turns: [
        {
            id: 'turn-1',
            startedAt: 100,
            items: [
                { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'first prompt' }] },
                { type: 'agentMessage', id: 'agent-1', text: 'first answer' },
            ],
        },
        {
            id: 'turn-2',
            startedAt: 200,
            items: [
                { type: 'userMessage', id: 'user-2', content: [{ type: 'text', text: 'second prompt' }] },
                { type: 'agentMessage', id: 'agent-2', text: 'second answer' },
            ],
        },
        {
            id: 'turn-3',
            startedAt: 300,
            items: [
                { type: 'userMessage', id: 'user-3', content: [{ type: 'text', text: 'third prompt' }] },
                { type: 'agentMessage', id: 'agent-3', text: 'third answer' },
            ],
        },
    ],
};

describe('codexThreadFork', () => {
    it('lists text user messages from Codex turns as rewind points', () => {
        expect(listCodexRewindPoints(threadWithTurns)).toEqual([
            { itemId: 'user-1', text: 'first prompt', timestamp: 100_000 },
            { itemId: 'user-2', text: 'second prompt', timestamp: 200_000 },
            { itemId: 'user-3', text: 'third prompt', timestamp: 300_000 },
        ]);
    });

    it('forks the full Codex thread without rollback when no cut point is requested', async () => {
        const client = {
            forkThread: vi.fn().mockResolvedValue({ threadId: 'thread-forked', model: 'gpt-test', thread: { id: 'thread-forked', turns: [] } }),
            rollbackThread: vi.fn(),
            injectItems: vi.fn(),
        };

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', cwd: '/tmp/project' });
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
    });

    it('forks, rolls back from the selected Codex user message, then re-injects that prompt', async () => {
        const client = {
            forkThread: vi.fn().mockResolvedValue({ threadId: 'thread-forked', model: 'gpt-test', thread: threadWithTurns }),
            rollbackThread: vi.fn().mockResolvedValue({ thread: { id: 'thread-forked', turns: threadWithTurns.turns.slice(0, 2) } }),
            injectItems: vi.fn().mockResolvedValue({}),
        };

        const result = await forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'user-2',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(client.rollbackThread).toHaveBeenCalledWith({ threadId: 'thread-forked', numTurns: 2 });
        expect(client.injectItems).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'second prompt' }],
            }],
        });
    });

    it('fails duplicate instead of silently returning a full fork when the selected Codex item is absent', async () => {
        const client = {
            forkThread: vi.fn().mockResolvedValue({ threadId: 'thread-forked', model: 'gpt-test', thread: threadWithTurns }),
            rollbackThread: vi.fn(),
            injectItems: vi.fn(),
        };

        await expect(forkCodexThread(client, {
            threadId: 'thread-source',
            cwd: '/tmp/project',
            cutAfterItemId: 'missing-user',
        })).rejects.toBeInstanceOf(CodexForkRewindPointNotFoundError);
        expect(client.rollbackThread).not.toHaveBeenCalled();
        expect(client.injectItems).not.toHaveBeenCalled();
    });
});

it('before-message rewinds only the independent fork and never re-injects the old prompt', async () => {
    const source = structuredClone(threadWithTurns);
    const fork = structuredClone(source);
    fork.id = 'fork';
    const client = {
        readThread: vi.fn().mockResolvedValue({ thread: source }),
        forkThread: vi.fn().mockResolvedValue({ threadId: 'fork', thread: fork }),
        rollbackThread: vi.fn(async ({ threadId, numTurns }) => {
            expect(threadId).toBe('fork');
            fork.turns.splice(fork.turns.length - numTurns);
            return { thread: fork };
        }),
        injectItems: vi.fn(),
    };
    expect(await forkCodexBeforeUserMessage(client, { threadId: source.id, cwd: '/project', cutBeforeItemId: 'user-2' }))
        .toEqual({ type: 'success', newCodexThreadId: 'fork' });
    expect(fork.turns).toEqual(threadWithTurns.turns.slice(0, 1));
    expect(source).toEqual(threadWithTurns);
    expect(client.injectItems).not.toHaveBeenCalled();
});

it('first-message rewind starts fresh without creating a fork; missing IDs fail', async () => {
    const client = {
        readThread: vi.fn().mockResolvedValue({ thread: threadWithTurns }),
        forkThread: vi.fn(), rollbackThread: vi.fn(), injectItems: vi.fn(),
    };
    expect(await forkCodexBeforeUserMessage(client, { threadId: 'source', cwd: '/project', cutBeforeItemId: 'user-1' }))
        .toEqual({ type: 'success', startFresh: true });
    await expect(forkCodexBeforeUserMessage(client, { threadId: 'source', cwd: '/project', cutBeforeItemId: 'missing' }))
        .rejects.toBeInstanceOf(CodexForkRewindPointNotFoundError);
    expect(client.forkThread).not.toHaveBeenCalled();
});

it('rejects within-turn targets and verifies actual rollback output', async () => {
    const source = structuredClone(threadWithTurns);
    source.turns[1].items.unshift({ type: 'userMessage', id: 'steer', content: [{ type: 'text', text: 'earlier prompt' }] });
    const client = {
        readThread: vi.fn().mockResolvedValue({ thread: source }),
        forkThread: vi.fn().mockResolvedValue({ threadId: 'fork', thread: threadWithTurns }),
        rollbackThread: vi.fn().mockResolvedValue({ thread: threadWithTurns }),
        injectItems: vi.fn(),
    };
    await expect(forkCodexBeforeUserMessage(client, { threadId: 'source', cwd: '/project', cutBeforeItemId: 'user-2' }))
        .rejects.toThrow('inside an existing turn');
    expect(client.forkThread).not.toHaveBeenCalled();
    client.readThread.mockResolvedValue({ thread: threadWithTurns });
    await expect(forkCodexBeforeUserMessage(client, { threadId: 'source', cwd: '/project', cutBeforeItemId: 'user-2' }))
        .rejects.toThrow('did not preserve');
});

it('marks attached Codex points and rejects editing them before any fork', async () => {
    const thread = { id: 'source', turns: [{ id: 'turn', items: [
        { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', url: 'image' }] },
    ] }] };
    expect(listCodexRewindPoints(thread)).toEqual([expect.objectContaining({ itemId: 'user', hasAttachments: true })]);
    const client = {
        readThread: vi.fn().mockResolvedValue({ thread }), forkThread: vi.fn(), rollbackThread: vi.fn(), injectItems: vi.fn(),
    };
    await expect(forkCodexBeforeUserMessage(client, { threadId: 'source', cwd: '/project', cutBeforeItemId: 'user' }))
        .rejects.toThrow('with attachments');
    expect(client.forkThread).not.toHaveBeenCalled();
});
