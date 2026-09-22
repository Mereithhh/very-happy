import { describe, expect, it, vi } from 'vitest';
import {
    SIDE_QUESTION_REMINDER,
    SIDE_QUESTION_SYSTEM_PROMPT,
    buildSideQuestionPrompt,
    isUnsupportedSideQuestionError,
    runSideQuestion,
    runSideQuestionLive,
    sideQuestionQueryOptions,
    toolAttemptNotice,
    type SideQuestionLiveRequest,
    type SideQuestionLiveResponse,
} from './sideQuestion';

const liveAsk = (impl: (request: SideQuestionLiveRequest, signal?: AbortSignal) => Promise<SideQuestionLiveResponse>) => vi.fn(impl);

function stream(messages: unknown[]) {
    return vi.fn((_params: { prompt: unknown; options?: unknown }) => ({
        async *[Symbol.asyncIterator]() {
            for (const m of messages) yield m as any;
        },
    }));
}

const base = { question: 'what does this error mean?', resumeSessionId: 'sess-1', cwd: '/repo' };

describe('buildSideQuestionPrompt (B-283)', () => {
    it('is the reminder followed by the question when there is no history', () => {
        expect(buildSideQuestionPrompt('  why?  ')).toBe(`${SIDE_QUESTION_REMINDER}\n\nwhy?`);
    });

    // 2026-09-22: a system-prompt tail alone let the fork answer as the main
    // agent ("现在真的起：" and then nothing — it reached for a tool). The
    // reminder must be the user-turn wording Claude Code's own /btw uses.
    it('carries Claude Code\'s /btw reminder in the user turn, directly before the question', () => {
        const prompt = buildSideQuestionPrompt('what now?');
        expect(prompt.startsWith('<system-reminder>This is a side question from the user.')).toBe(true);
        expect(prompt.endsWith('</system-reminder>\n\nwhat now?')).toBe(true);
        for (const clause of [
            'You are a separate, lightweight agent spawned to answer this one question',
            'The main agent is NOT interrupted',
            'Do NOT reference being interrupted or what you were "previously doing"',
            'You have NO tools available',
            'NEVER say things like "Let me try...", "I\'ll now...", "Let me check..."',
            'If you don\'t know the answer, say so',
        ]) expect(prompt).toContain(clause);
    });

    it('prepends earlier exchanges as a bounded block, keeping the reminder next to the question', () => {
        const prompt = buildSideQuestionPrompt('next', [
            { question: 'q1', answer: 'a1' },
            { question: '   ', answer: 'skipped' },
            { question: 'q2', answer: 'a'.repeat(5000) },
        ]);
        expect(prompt.startsWith('<earlier-side-questions>\nQ: q1\nA: a1\n\nQ: q2\nA: ')).toBe(true);
        expect(prompt).toContain(`</earlier-side-questions>\n\n${SIDE_QUESTION_REMINDER}\n\nnext`);
        expect(prompt.endsWith('\n\nnext')).toBe(true);
        expect(prompt).not.toContain('skipped');
        expect(prompt.length).toBeLessThan(2200 + SIDE_QUESTION_REMINDER.length);
    });

    it('keeps only the most recent twelve exchanges', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
        const prompt = buildSideQuestionPrompt('x', history);
        expect(prompt).not.toContain('Q: q7\n');
        expect(prompt).toContain('Q: q8\n');
        expect(prompt).toContain('Q: q19\n');
    });
});

describe('sideQuestionQueryOptions', () => {
    it('forks the live session, disables every tool and never persists', async () => {
        const options = sideQuestionQueryOptions({ ...base, model: 'opus', env: { HAPPY_MANAGED: '1' }, settingsPath: '/tmp/sq.json' });
        expect(options).toEqual(expect.objectContaining({
            cwd: '/repo',
            resume: 'sess-1',
            forkSession: true,
            persistSession: false,
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            maxTurns: 1,
            includePartialMessages: true,
            permissionMode: 'default',
            model: 'opus',
            env: { HAPPY_MANAGED: '1' },
            settingsPath: '/tmp/sq.json',
            appendSystemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
        }));
        expect(options.allowDangerouslySkipPermissions).toBeUndefined();
        await expect(options.canCallTool!('Bash', {}, {} as any)).resolves.toEqual(
            expect.objectContaining({ behavior: 'deny' }),
        );
    });

    it('runs without context (no resume/fork) before the first main turn', () => {
        const options = sideQuestionQueryOptions({ ...base, resumeSessionId: null });
        expect(options.resume).toBeUndefined();
        expect(options.forkSession).toBeUndefined();
        expect(options.persistSession).toBe(false);
    });
});

describe('runSideQuestion', () => {
    it('streams deltas progressively and returns the final assistant text', async () => {
        const query = stream([
            { type: 'system', subtype: 'init' },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
            { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
            { type: 'result', subtype: 'success', result: 'Hello' },
        ]);
        const onText = vi.fn();
        const result = await runSideQuestion(query as any, { ...base, onText });
        expect(result).toEqual({ answer: 'Hello', hadContext: true, mode: 'fork' });
        expect(onText.mock.calls.map((c) => c[0])).toEqual(['Hel', 'Hello', 'Hello']);
        expect(query.mock.calls[0]?.[0].prompt).toBe(buildSideQuestionPrompt(base.question));
    });

    it('turns a tool_use attempt into Claude Code\'s notice instead of a blank or an error', async () => {
        const query = stream([
            { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
            { type: 'result', subtype: 'error_max_turns', errors: [] },
        ]);
        const onText = vi.fn();
        const result = await runSideQuestion(query as any, { ...base, onText });
        expect(result.answer).toBe(toolAttemptNotice('Bash'));
        expect(onText).toHaveBeenLastCalledWith(toolAttemptNotice('Bash'));
    });

    it('keeps the text the model wrote before reaching for a tool', async () => {
        const query = stream([
            { type: 'assistant', message: { content: [{ type: 'text', text: 'Short answer.' }, { type: 'tool_use', name: 'Read', input: {} }] } },
            { type: 'result', subtype: 'success', result: 'Short answer.' },
        ]);
        await expect(runSideQuestion(query as any, base)).resolves.toEqual({ answer: 'Short answer.', hadContext: true, mode: 'fork' });
    });

    it('names the API error when the run fails without a result payload', async () => {
        const query = stream([
            { type: 'system', subtype: 'api_error', error: { formatted: '529 overloaded' } },
            { type: 'result', subtype: 'error_during_execution', errors: [] },
        ]);
        await expect(runSideQuestion(query as any, base)).rejects.toThrow('Side question failed: 529 overloaded');
    });

    it('maps a non-success result to an error', async () => {
        const query = stream([{ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }]);
        await expect(runSideQuestion(query as any, base)).rejects.toThrow('Side question failed: boom');
    });

    it('reports cancellation when the signal aborted mid-stream', async () => {
        const controller = new AbortController();
        const query = vi.fn(() => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } } as any;
                controller.abort();
            },
        }));
        await expect(runSideQuestion(query as any, { ...base, signal: controller.signal })).rejects.toThrow('cancelled');
    });

    it('fails loudly on an empty stream', async () => {
        await expect(runSideQuestion(stream([]) as any, base)).rejects.toThrow('without a result');
    });
});

describe('runSideQuestionLive (B-482, in-process /btw)', () => {
    it('sends the question with history in Claude Code\'s btwHistory shape and returns the live answer', async () => {
        const ask = liveAsk(async () => ({ response: 'It is running the tests.', synthetic: false }));
        const onText = vi.fn();
        const result = await runSideQuestionLive(ask, {
            ...base,
            question: '  what now?  ',
            history: [
                { question: 'q1', answer: 'a1' },
                { question: 'blank', answer: '   ' },
                { question: 'q2', answer: 'a'.repeat(5000) },
            ],
            onText,
        });
        expect(result).toEqual({ answer: 'It is running the tests.', hadContext: true, mode: 'live' });
        expect(onText).toHaveBeenCalledWith('It is running the tests.');
        const [request, signal] = ask.mock.calls[0]!;
        expect(request!.question).toBe('what now?');
        expect(request!.history).toHaveLength(2);
        expect(request!.history![0]).toEqual({ question: 'q1', response: 'a1' });
        expect(request!.history![1]!.response.length).toBeLessThanOrEqual(2001);
        expect(request!.history![1]).not.toHaveProperty('answer');
        expect(signal).toBeUndefined();
    });

    it('omits history when there is none and prefixes a refusal fallback notice', async () => {
        const ask = liveAsk(async () => ({
            response: 'answer',
            refusal_fallback: { original_model: 'a', fallback_model: 'b', content: 'Answered by b after a refused' },
        }));
        const result = await runSideQuestionLive(ask, base);
        expect(ask.mock.calls[0]![0]).toEqual({ question: base.question });
        expect(result.answer).toBe('⚠ Answered by b after a refused\n\nanswer');
    });

    it('passes the abort signal through and reports cancellation', async () => {
        const controller = new AbortController();
        const ask = vi.fn(async (_r: unknown, signal?: AbortSignal) => { controller.abort(); expect(signal).toBe(controller.signal); return { response: null }; });
        await expect(runSideQuestionLive(ask, { ...base, signal: controller.signal })).rejects.toThrow('cancelled');
    });

    it('fails loudly on an empty live answer', async () => {
        await expect(runSideQuestionLive(async () => ({ response: null }), base)).rejects.toThrow('without a result');
        await expect(runSideQuestionLive(async () => ({ response: '   ' }), base)).rejects.toThrow('without a result');
    });

    it('recognises an old CLI\'s unknown-subtype verdict', () => {
        expect(isUnsupportedSideQuestionError(new Error('Unknown control request subtype: side_question'))).toBe(true);
        expect(isUnsupportedSideQuestionError(new Error('unsupported request'))).toBe(true);
        expect(isUnsupportedSideQuestionError(new Error('API Error: 529 overloaded'))).toBe(false);
        expect(isUnsupportedSideQuestionError(new Error('Query closed before response received'))).toBe(false);
    });
});
