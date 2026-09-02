import { describe, expect, it, vi } from 'vitest';
import { registerSideQuestionHandler, type SideQuestionPollResponse } from './registerSideQuestionHandler';

type Handler = (request: any) => Promise<any>;

function harness(opts: { run?: (input: any) => Promise<{ answer: string; hadContext: boolean }>; claudeSessionId?: string | null; maxRunMs?: number } = {}) {
    const handlers = new Map<string, Handler>();
    let clock = 1000;
    const rpc = { registerHandler: (method: string, handler: Handler) => { handlers.set(method, handler); } };
    const run = opts.run ?? (async (input: any) => {
        input.onText?.('partial');
        return { answer: 'final answer', hadContext: Boolean(input.resumeSessionId) };
    });
    const runSpy = vi.fn(run);
    registerSideQuestionHandler(rpc, {
        getClaudeSessionId: () => (opts.claudeSessionId === undefined ? 'claude-1' : opts.claudeSessionId),
        getModel: () => 'opus',
        cwd: '/repo',
        run: runSpy,
        now: () => clock,
        retainMs: 1000,
        maxRunMs: opts.maxRunMs,
        getEnv: () => ({ ANTHROPIC_BASE_URL: 'https://hub.example' }),
        settingsPath: '/tmp/side-question.json',
    });
    const call = (method: string, request?: unknown) => handlers.get(method)!(request);
    return { call, runSpy, tick: (ms: number) => { clock += ms; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('registerSideQuestionHandler (B-283)', () => {
    it('registers the three btw RPCs', () => {
        const handlers: string[] = [];
        registerSideQuestionHandler({ registerHandler: (m: string) => { handlers.push(m); } }, {
            getClaudeSessionId: () => null, getModel: () => undefined, cwd: '/', run: async () => ({ answer: '', hadContext: false }),
        });
        expect(handlers).toEqual(['btw-ask', 'btw-poll', 'btw-cancel']);
    });

    it('ask returns immediately; poll sees progressive text then done', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const h = harness({
            run: async (input) => { input.onText('so far'); await gate; return { answer: 'done text', hadContext: true }; },
        });
        const ask = await h.call('btw-ask', { question: ' why? ', history: [{ question: 'q', answer: 'a' }, { bogus: 1 }] });
        expect(ask.hadContext).toBe(true);
        expect(h.runSpy).toHaveBeenCalledWith(expect.objectContaining({
            question: 'why?',
            history: [{ question: 'q', answer: 'a' }],
            resumeSessionId: 'claude-1',
            cwd: '/repo',
            model: 'opus',
            env: { ANTHROPIC_BASE_URL: 'https://hub.example' },
            settingsPath: '/tmp/side-question.json',
        }));
        await flush();
        const running: SideQuestionPollResponse = await h.call('btw-poll', { requestId: ask.requestId });
        expect(running).toEqual(expect.objectContaining({ status: 'running', text: 'so far', startedAt: 1000 }));
        release();
        await flush();
        const done: SideQuestionPollResponse = await h.call('btw-poll', { requestId: ask.requestId });
        expect(done).toEqual(expect.objectContaining({ status: 'done', text: 'done text', finishedAt: 1000 }));
    });

    it('rejects empty, oversized and concurrent questions', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const h = harness({ run: async () => { await gate; return { answer: 'x', hadContext: true }; } });
        await expect(h.call('btw-ask', { question: '   ' })).rejects.toThrow('empty');
        await expect(h.call('btw-ask', { question: 'x'.repeat(8001) })).rejects.toThrow('too long');
        await h.call('btw-ask', { question: 'first' });
        await expect(h.call('btw-ask', { question: 'second' })).rejects.toThrow('already running');
        release();
        await flush();
        await expect(h.call('btw-ask', { question: 'third' })).resolves.toEqual(expect.objectContaining({ requestId: expect.any(String) }));
    });

    it('surfaces run failures as error status', async () => {
        const h = harness({ run: async () => { throw new Error('OAuth session expired'); } });
        const ask = await h.call('btw-ask', { question: 'q' });
        await flush();
        expect(await h.call('btw-poll', { requestId: ask.requestId })).toEqual(expect.objectContaining({
            status: 'error', error: 'OAuth session expired',
        }));
    });

    it('cancel aborts the running query and frees the slot', async () => {
        const h = harness({
            run: (input) => new Promise((_, reject) => {
                input.signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        });
        const ask = await h.call('btw-ask', { question: 'q' });
        expect(await h.call('btw-cancel', { requestId: ask.requestId })).toEqual({ cancelled: true });
        await flush();
        expect(await h.call('btw-poll', { requestId: ask.requestId })).toEqual(expect.objectContaining({ status: 'cancelled' }));
        expect(await h.call('btw-cancel', { requestId: ask.requestId })).toEqual({ cancelled: false });
        await expect(h.call('btw-ask', { question: 'again' })).resolves.toBeTruthy();
    });

    it('frees a slot whose run never settles once the wall-clock cap elapses', async () => {
        vi.useFakeTimers();
        try {
            const aborted = vi.fn();
            const h = harness({
                maxRunMs: 5000,
                run: (input) => new Promise((_, reject) => {
                    input.signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); });
                }),
            });
            const ask = await h.call('btw-ask', { question: 'q' });
            await expect(h.call('btw-ask', { question: 'again' })).rejects.toThrow('already running');
            await vi.advanceTimersByTimeAsync(5001);
            expect(aborted).toHaveBeenCalledTimes(1);
            expect(await h.call('btw-poll', { requestId: ask.requestId })).toEqual(expect.objectContaining({
                status: 'error', error: 'Side question timed out',
            }));
            await expect(h.call('btw-ask', { question: 'again' })).resolves.toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('drops finished results after the retain window and reports no context before first turn', async () => {
        const h = harness({ claudeSessionId: null });
        const ask = await h.call('btw-ask', { question: 'q' });
        expect(ask.hadContext).toBe(false);
        await flush();
        expect((await h.call('btw-poll', { requestId: ask.requestId })).status).toBe('done');
        h.tick(1001);
        await expect(h.call('btw-poll', { requestId: ask.requestId })).rejects.toThrow('Unknown side question');
        await expect(h.call('btw-poll', { requestId: 'nope' })).rejects.toThrow('Unknown side question');
    });
});
