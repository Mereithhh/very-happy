import { describe, expect, it, vi } from 'vitest';
import { SIDE_QUESTION_REMINDER } from '@/claude/sideQuestion';
import { CODEX_SIDE_QUESTION_INSTRUCTIONS, runCodexSideQuestion, type CodexSideClient } from './codexSideQuestion';

type Script = (emit: (method: string, params: any) => void, call: { threadId: string; text: string }) => void;

function fakeClient(opts: { script?: Script; forkFails?: boolean } = {}) {
    const listeners = new Set<(method: string, params: any) => void>();
    const emit = (method: string, params: any) => { for (const l of listeners) l(method, params); };
    const calls = {
        open: [] as { sourceThreadId: string | null; developerInstructions: string; model?: string }[],
        turns: [] as { threadId: string; text: string }[],
        interrupts: [] as string[],
        disconnects: 0,
        connects: 0,
    };
    let n = 0;
    const client: CodexSideClient = {
        connect: async () => { calls.connects++; },
        disconnect: async () => { calls.disconnects++; },
        onRawNotification: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        openSideThread: async (o) => {
            calls.open.push(o);
            if (o.sourceThreadId && opts.forkFails) throw new Error('thread/fork: no rollout found');
            return { threadId: `side-${++n}` };
        },
        startSideTurn: async (threadId, text) => {
            const call = { threadId, text };
            calls.turns.push(call);
            queueMicrotask(() => (opts.script ?? answer('PELICAN-7731'))(emit, call));
            return 'turn-1';
        },
        interruptSideTurn: async (threadId, turnId) => {
            calls.interrupts.push(`${threadId}/${turnId}`);
            queueMicrotask(() => emit('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } }));
        },
    };
    return { client, calls, emit };
}

const answer = (text: string): Script => (emit, { threadId }) => {
    emit('item/agentMessage/delta', { threadId, delta: text.slice(0, 4) });
    emit('item/agentMessage/delta', { threadId, delta: text.slice(4) });
    emit('item/completed', { threadId, item: { id: 'm1', type: 'agentMessage', text } });
    emit('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
};

const base = { question: 'What is the codeword?', resumeSessionId: 'main-thread', cwd: '/proj' };

describe('runCodexSideQuestion (B-861)', () => {
    it('forks the main thread into a side thread, streams the answer and stops the side app-server', async () => {
        const { client, calls } = fakeClient();
        const onText = vi.fn();
        const result = await runCodexSideQuestion(() => client, { ...base, model: 'gpt-x', history: [{ question: 'q0', answer: 'a0' }], onText });
        expect(result).toEqual({ answer: 'PELICAN-7731', hadContext: true, mode: 'fork' });
        expect(calls.open).toEqual([{ sourceThreadId: 'main-thread', cwd: '/proj', model: 'gpt-x', developerInstructions: CODEX_SIDE_QUESTION_INSTRUCTIONS }]);
        // The turn runs on the SIDE thread only — never the main thread id.
        expect(calls.turns.map((t) => t.threadId)).toEqual(['side-1']);
        expect(calls.turns[0].text).toContain(SIDE_QUESTION_REMINDER);
        expect(calls.turns[0].text).toContain('Q: q0\nA: a0');
        expect(onText.mock.calls.map((c) => c[0])).toEqual(['PELI', 'PELICAN-7731', 'PELICAN-7731']);
        expect(calls.disconnects).toBe(1);
    });

    it('ignores notifications of other threads (the main thread never feeds the side answer)', async () => {
        const { client } = fakeClient({
            script: (emit, { threadId }) => {
                emit('item/completed', { threadId: 'main-thread', item: { id: 'x', type: 'agentMessage', text: 'MAIN' } });
                emit('turn/completed', { threadId: 'main-thread', turn: { status: 'completed' } });
                answer('SIDE')(emit, { threadId, text: '' });
            },
        });
        expect((await runCodexSideQuestion(() => client, base)).answer).toBe('SIDE');
    });

    it('answers without context before the main thread exists', async () => {
        const { client, calls } = fakeClient();
        const result = await runCodexSideQuestion(() => client, { ...base, resumeSessionId: null });
        expect(result.hadContext).toBe(false);
        expect(calls.open[0].sourceThreadId).toBeNull();
    });

    it('falls back to a context-free side thread when the fork is refused', async () => {
        const { client, calls } = fakeClient({ forkFails: true });
        const result = await runCodexSideQuestion(() => client, base);
        expect(result.hadContext).toBe(false);
        expect(calls.open.map((o) => o.sourceThreadId)).toEqual(['main-thread', null]);
    });

    it('interrupts a tool attempt and returns the Claude-style notice', async () => {
        const { client, calls } = fakeClient({
            script: (emit, { threadId }) => {
                emit('item/completed', { threadId, item: { id: 'm1', type: 'agentMessage', text: 'The codeword is X.' } });
                emit('item/started', { threadId, item: { id: 'c1', type: 'commandExecution', command: 'ls /' } });
            },
        });
        const result = await runCodexSideQuestion(() => client, base);
        expect(calls.interrupts).toEqual(['side-1/turn-1']);
        expect(result.answer).toBe('The codeword is X.\n\n(The model tried to call a shell command instead of answering directly. Try rephrasing or ask in the main conversation.)');
    });

    it('cancel interrupts the side turn, rejects, and still stops the side app-server', async () => {
        const controller = new AbortController();
        const { client, calls } = fakeClient({ script: () => { queueMicrotask(() => controller.abort()); } });
        await expect(runCodexSideQuestion(() => client, { ...base, signal: controller.signal })).rejects.toThrow('cancelled');
        expect(calls.interrupts).toEqual(['side-1/turn-1']);
        expect(calls.disconnects).toBe(1);
    });

    it('maps a failed turn to its error', async () => {
        const { client, calls } = fakeClient({
            script: (emit, { threadId }) => emit('turn/completed', { threadId, turn: { status: 'failed', error: { message: '429 Too Many Requests' } } }),
        });
        await expect(runCodexSideQuestion(() => client, base)).rejects.toThrow('429 Too Many Requests');
        expect(calls.disconnects).toBe(1);
    });
});
