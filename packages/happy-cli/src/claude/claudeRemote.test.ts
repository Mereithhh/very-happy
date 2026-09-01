import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['event:Context was reset', 'reset', 'ready']);
    });

    it('opts the remote Query into a later user-requested live bypass', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            async *[Symbol.asyncIterator]() {},
        } as any);
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => (++messageCount === 1 ? { message: 'hello', mode: { permissionMode: 'plan' } } : null),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(vi.mocked(query).mock.calls[0][0].options).toEqual(expect.objectContaining({
            permissionMode: 'plan',
            allowDangerouslySkipPermissions: true,
        }));
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });

    it.each([
        { selectedModel: undefined, expectedDefault: true },
        { selectedModel: 'haiku', expectedDefault: false },
    ])('reports whether the resolved SDK model came from machine defaults', async ({ selectedModel, expectedDefault }) => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'system',
                    subtype: 'init',
                    model: 'claude-opus-5[1m]',
                };
                yield { type: 'result', subtype: 'success' };
            },
        } as any);

        const onSDKMetadata = vi.fn();
        let messageCount = 0;
        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? { message: 'hello', mode: { ...mode, model: selectedModel } }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onSDKMetadata,
        });

        expect(onSDKMetadata).toHaveBeenCalledWith(expect.objectContaining({
            model: 'claude-opus-5[1m]',
            modelIsDefault: expectedDefault,
        }));
    });

    it('does not read a queued follow-up until the current result arrives', async () => {
        let releaseFirstResult!: () => void;
        const firstResultGate = new Promise<void>((resolve) => { releaseFirstResult = resolve; });
        const observedInputs: string[] = [];
        const interrupt = vi.fn();

        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt,
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                observedInputs.push((await input.next()).value.message.content);
                yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } };
                await firstResultGate;
                yield { type: 'result', subtype: 'success', is_error: false };
                observedInputs.push((await input.next()).value.message.content);
                yield { type: 'result', subtype: 'success', is_error: false };
                expect((await input.next()).done).toBe(true);
            },
        } as any));

        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'first', mode })
            .mockResolvedValueOnce({ message: 'queued follow-up', mode })
            .mockResolvedValueOnce(null);
        const onThinkingChange = vi.fn();
        const running = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange,
            onMessage: vi.fn(),
        });

        await vi.waitFor(() => expect(observedInputs).toEqual(['first']));
        expect(nextMessage).toHaveBeenCalledTimes(1);
        expect(interrupt).not.toHaveBeenCalled();
        releaseFirstResult();
        await running;

        expect(observedInputs).toEqual(['first', 'queued follow-up']);
        expect(nextMessage).toHaveBeenCalledTimes(3);
        expect(onThinkingChange.mock.calls.map(([thinking]) => thinking)).toEqual([true, false, true, false]);
        expect(interrupt).not.toHaveBeenCalled();
    });

    it('streams Steer into the current turn with priority now and never calls interrupt', async () => {
        const observedInputs: any[] = [];
        const interrupt = vi.fn();
        let controls!: { steer: (message: string, mode: EnhancedMode) => void };

        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt,
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                observedInputs.push((await input.next()).value);
                yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } };
                observedInputs.push((await input.next()).value);
                yield { type: 'result', subtype: 'success', is_error: false };
                expect((await input.next()).done).toBe(true);
            },
        } as any));

        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'first', mode })
            .mockResolvedValueOnce(null);
        const running = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onQueryReady: (queryControls) => { controls = queryControls; },
        });

        await vi.waitFor(() => expect(observedInputs).toHaveLength(1));
        controls.steer('adjust direction', mode);
        await running;

        expect(observedInputs[0]).toMatchObject({
            type: 'user',
            origin: { kind: 'human' },
            message: { content: 'first' },
        });
        expect(observedInputs[1]).toMatchObject({
            type: 'user',
            priority: 'now',
            origin: { kind: 'human' },
            message: { content: 'adjust direction' },
        });
        expect(nextMessage).toHaveBeenCalledTimes(2);
        expect(interrupt).not.toHaveBeenCalled();
    });

    it('ends the Query after a turn that failed OAuth refresh so the next message spawns a fresh process', async () => {
        // Claude Code caches a failed refresh per process: feeding the next
        // prompt into this Query would replay "OAuth session expired" forever
        // (2026-09-01 mac-office wedge). The launcher loop must get a fresh one.
        const observedInputs: string[] = [];
        let inputEnded = false;
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                observedInputs.push((await input.next()).value.message.content);
                yield {
                    type: 'assistant',
                    error: 'authentication_failed',
                    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
                };
                yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' };
                inputEnded = (await input.next()).done === true;
            },
        } as any));

        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'first', mode })
            .mockResolvedValueOnce({ message: 'queued follow-up', mode })
            .mockResolvedValueOnce(null);
        const onCompletionEvent = vi.fn();
        const onReady = vi.fn();
        const onThinkingChange = vi.fn();

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage,
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange,
            onMessage: vi.fn(),
            onCompletionEvent,
        });

        // The poisoned Query saw only the first prompt; the queued follow-up
        // stays in the queue for the launcher's next (fresh) claudeRemote.
        expect(observedInputs).toEqual(['first']);
        expect(inputEnded).toBe(true);
        expect(nextMessage).toHaveBeenCalledTimes(1);
        expect(onReady).toHaveBeenCalledOnce();
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('could not refresh its OAuth session'));
        expect(onThinkingChange.mock.calls.map(([thinking]) => thinking)).toEqual([true, false]);
    });

    it('keeps feeding the same Query after a non-auth API error result', async () => {
        const observedInputs: string[] = [];
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                observedInputs.push((await input.next()).value.message.content);
                yield { type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }] } };
                yield { type: 'result', subtype: 'success', is_error: true, result: 'Rate limited' };
                observedInputs.push((await input.next()).value.message.content);
                yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
                expect((await input.next()).done).toBe(true);
            },
        } as any));

        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'first', mode })
            .mockResolvedValueOnce({ message: 'retry', mode })
            .mockResolvedValueOnce(null);
        const onCompletionEvent = vi.fn();

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
        });

        expect(observedInputs).toEqual(['first', 'retry']);
        expect(nextMessage).toHaveBeenCalledTimes(3);
        expect(onCompletionEvent).not.toHaveBeenCalled();
    });
});
