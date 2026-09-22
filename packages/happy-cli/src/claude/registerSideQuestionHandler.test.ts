import { describe, expect, it, vi } from 'vitest';
import { registerSideQuestionHandler, type SideQuestionPollResponse } from './registerSideQuestionHandler';
import type { SideQuestionLiveQuery, SideQuestionLiveRequest, SideQuestionLiveResponse } from './sideQuestion';

type Handler = (request: any) => Promise<any>;

function harness(opts: { run?: (input: any) => Promise<{ answer: string; hadContext: boolean }>; claudeSessionId?: string | null; maxRunMs?: number; getLiveQuery?: () => SideQuestionLiveQuery | null } = {}) {
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
        getLiveQuery: opts.getLiveQuery,
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

    it('rejects empty and oversized questions', async () => {
        const h = harness();
        await expect(h.call('btw-ask', { question: '   ' })).rejects.toThrow('empty');
        await expect(h.call('btw-ask', { question: 'x'.repeat(8001) })).rejects.toThrow('too long');
    });

    it('a new ask supersedes a running one instead of failing (client that lost the request id)', async () => {
        const aborted: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const h = harness({
            run: (input) => new Promise((resolve, reject) => {
                input.signal.addEventListener('abort', () => { aborted.push(input.question); reject(new Error('aborted')); });
                void gate.then(() => resolve({ answer: 'x', hadContext: true }));
            }),
        });
        const first = await h.call('btw-ask', { question: 'first' });
        const second = await h.call('btw-ask', { question: 'second' });
        expect(second.requestId).not.toBe(first.requestId);
        expect(aborted).toEqual(['first']);
        await flush();
        expect(await h.call('btw-poll', { requestId: first.requestId })).toEqual(expect.objectContaining({ status: 'cancelled' }));
        expect(await h.call('btw-poll', { requestId: second.requestId })).toEqual(expect.objectContaining({ status: 'running' }));
        release();
        await flush();
        expect(await h.call('btw-poll', { requestId: second.requestId })).toEqual(expect.objectContaining({ status: 'done', text: 'x' }));
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

    describe('live (in-process) path, B-482', () => {
        it('prefers the running Query and reports mode=live with context', async () => {
            const ask = vi.fn(async (_request: SideQuestionLiveRequest, _signal?: AbortSignal): Promise<SideQuestionLiveResponse> => ({ response: 'live answer' }));
            const fork = vi.fn(async () => ({ answer: 'fork answer', hadContext: true }));
            const h = harness({ run: fork, claudeSessionId: null, getLiveQuery: () => ({ ask, canControl: () => true }) });
            const ack = await h.call('btw-ask', { question: 'q', history: [{ question: 'a', answer: 'b' }] });
            expect(ack).toEqual(expect.objectContaining({ hadContext: true, mode: 'live' }));
            await flush();
            expect(await h.call('btw-poll', { requestId: ack.requestId })).toEqual(expect.objectContaining({ status: 'done', text: 'live answer' }));
            expect(fork).not.toHaveBeenCalled();
            expect(ask.mock.calls[0]![0]).toEqual({ question: 'q', history: [{ question: 'a', response: 'b' }] });
        });

        it('forks while the wrapper sits inside an SDK callback (canControl false) and when no Query is alive', async () => {
            const ask = vi.fn(async () => ({ response: 'live answer' }));
            const fork = vi.fn(async () => ({ answer: 'fork answer', hadContext: true }));
            const blocked = harness({ run: fork, getLiveQuery: () => ({ ask, canControl: () => false }) });
            const a = await blocked.call('btw-ask', { question: 'q' });
            expect(a).toEqual(expect.objectContaining({ mode: 'fork' }));
            const none = harness({ run: fork, getLiveQuery: () => null });
            const b = await none.call('btw-ask', { question: 'q' });
            expect(b).toEqual(expect.objectContaining({ mode: 'fork' }));
            await flush();
            expect(ask).not.toHaveBeenCalled();
            expect(fork).toHaveBeenCalledTimes(2);
            expect(await none.call('btw-poll', { requestId: b.requestId })).toEqual(expect.objectContaining({ status: 'done', text: 'fork answer' }));
        });

        it('falls back to the fork when the CLI does not know the subtype, but not on other live errors', async () => {
            const fork = vi.fn(async () => ({ answer: 'fork answer', hadContext: true }));
            const old = harness({ run: fork, getLiveQuery: () => ({ ask: async () => { throw new Error('Unknown control request subtype: side_question'); }, canControl: () => true }) });
            const a = await old.call('btw-ask', { question: 'q' });
            await flush();
            expect(await old.call('btw-poll', { requestId: a.requestId })).toEqual(expect.objectContaining({ status: 'done', text: 'fork answer' }));
            const broken = harness({ run: fork, getLiveQuery: () => ({ ask: async () => { throw new Error('API Error: 529 overloaded'); }, canControl: () => true }) });
            const b = await broken.call('btw-ask', { question: 'q' });
            await flush();
            expect(await broken.call('btw-poll', { requestId: b.requestId })).toEqual(expect.objectContaining({ status: 'error', error: 'API Error: 529 overloaded' }));
            expect(fork).toHaveBeenCalledTimes(1);
        });

        it('cancel aborts the live control request', async () => {
            let seen: AbortSignal | undefined;
            const h = harness({
                getLiveQuery: () => ({
                    canControl: () => true,
                    ask: (_r, signal) => new Promise((_, reject) => { seen = signal; signal!.addEventListener('abort', () => reject(new Error('aborted'))); }),
                }),
            });
            const ask = await h.call('btw-ask', { question: 'q' });
            expect(await h.call('btw-cancel', { requestId: ask.requestId })).toEqual({ cancelled: true });
            await flush();
            expect(seen?.aborted).toBe(true);
            expect(await h.call('btw-poll', { requestId: ask.requestId })).toEqual(expect.objectContaining({ status: 'cancelled' }));
        });
    });
});
