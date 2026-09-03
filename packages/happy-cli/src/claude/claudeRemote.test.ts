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

    /**
     * B-292: the model is the one mode field the SDK can move on a LIVE Query.
     * Before this, a model change was applied by killing the Claude Code process
     * and replaying the message into a fresh Query — which is how it ended up
     * depending on (and silently lost to) the launcher's park-and-replay path.
     */
    describe('live model switching', () => {
        const runTwoTurns = async (opts: {
            models: Array<string | undefined>;
            setModel: ReturnType<typeof vi.fn>;
            onCompletionEvent?: ReturnType<typeof vi.fn>;
        }) => {
            // What each turn's prompt saw at the moment it reached the Query.
            const observed: Array<{ prompt: unknown; afterSwitch: boolean }> = [];
            let switchResolved = false;
            const trackedSetModel = vi.fn(async (model?: string) => {
                await opts.setModel(model);
                switchResolved = true;
            });

            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                setModel: trackedSetModel,
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    const first = await input.next();
                    observed.push({ prompt: first.value.message.content, afterSwitch: switchResolved });
                    yield { type: 'result', subtype: 'success' };
                    // Parks here until the turn-boundary hand-off pushes the next
                    // prompt — which is exactly the ordering under test.
                    const second = await input.next();
                    if (!second.done) {
                        observed.push({ prompt: second.value.message.content, afterSwitch: switchResolved });
                    }
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));

            let n = 0;
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => {
                    const index = n++;
                    if (index >= opts.models.length) return null;
                    return { message: `turn ${index}`, mode: { ...mode, model: opts.models[index] } };
                },
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
                onCompletionEvent: opts.onCompletionEvent,
            });
            return observed;
        };

        it('applies a mid-conversation model change with setModel instead of a respawn', async () => {
            const setModel = vi.fn(async () => {});
            await runTwoTurns({ models: ['opus', 'sonnet'], setModel });
            expect(setModel).toHaveBeenCalledWith('sonnet');
            // The Query is created ONCE — the switch must not need a new one.
            expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(query).mock.calls[0][0].options).toEqual(expect.objectContaining({ model: 'opus' }));
        });

        /**
         * Ordering is load-bearing: the SDK's input loop writes a queued user
         * message to Claude Code's stdin eagerly, so a prompt pushed before the
         * set_model control request lands would be answered by the OLD model —
         * B-292's symptom, with every other assertion still green.
         */
        it('does not hand the next prompt to the Query until the switch has resolved', async () => {
            const setModel = vi.fn(async () => {});
            const observed = await runTwoTurns({ models: ['opus', 'sonnet'], setModel });
            expect(observed).toHaveLength(2);
            expect(observed[0]).toEqual({ prompt: 'turn 0', afterSwitch: false });
            expect(observed[1]).toEqual({ prompt: 'turn 1', afterSwitch: true });
        });

        it('does not touch the model when the next turn keeps it', async () => {
            const setModel = vi.fn(async () => {});
            await runTwoTurns({ models: ['opus', 'opus'], setModel });
            expect(setModel).not.toHaveBeenCalled();
        });

        it('treats null and undefined as the same "machine default" state', async () => {
            const setModel = vi.fn(async () => {});
            await runTwoTurns({ models: [undefined, null as unknown as undefined], setModel });
            expect(setModel).not.toHaveBeenCalled();
        });

        it('switching back to the machine default clears the model', async () => {
            const setModel = vi.fn(async () => {});
            await runTwoTurns({ models: ['opus', undefined], setModel });
            expect(setModel).toHaveBeenCalledWith(undefined);
        });

        it('reports a rejected switch and keeps the turn alive on the previous model', async () => {
            const setModel = vi.fn(async () => {
                throw new Error('Model "fable5" is not a recognized model id.');
            });
            const onCompletionEvent = vi.fn();
            const observed = await runTwoTurns({ models: ['opus', 'fable5'], setModel, onCompletionEvent });
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('fable5'));
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('not a recognized model id'));
            // The turn still runs — on the model that is already loaded.
            expect(observed.map((o) => o.prompt)).toEqual(['turn 0', 'turn 1']);
        });

        /**
         * `model` is out of the relaunch hash, so a Steer carrying a different
         * model now passes the launcher's gate. A model cannot move mid-turn, so
         * claudeRemote must keep the RUNNING model on the steer — otherwise the
         * next turn boundary compares the target against itself, never calls
         * setModel, and the picked model never loads.
         */
        it('keeps the running model through a Steer, so the next turn still switches', async () => {
            const setModel = vi.fn(async () => {});
            let controls: any;
            const observedInputs: string[] = [];
            let releaseTurn: () => void = () => {};
            const steered = new Promise<void>((resolve) => { releaseTurn = resolve; });

            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                setModel,
                interrupt: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observedInputs.push((await input.next()).value.message.content);
                    await steered;
                    observedInputs.push((await input.next()).value.message.content);
                    yield { type: 'result', subtype: 'success' };
                    const next = await input.next();
                    if (!next.done) observedInputs.push(next.value.message.content);
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));

            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'first', mode: { ...mode, model: 'opus' } })
                .mockResolvedValueOnce({ message: 'after steer', mode: { ...mode, model: 'sonnet' } })
                .mockResolvedValue(null);

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
            // The steer carries the NEW model. It must not be applied mid-turn…
            controls.steer('adjust direction', { ...mode, model: 'sonnet' });
            releaseTurn();
            await running;

            expect(setModel).not.toHaveBeenCalledWith(undefined);
            // …and the next ordinary turn, which carries the same new model, must
            // still see it as a change and apply it.
            expect(setModel).toHaveBeenCalledTimes(1);
            expect(setModel).toHaveBeenCalledWith('sonnet');
            expect(observedInputs).toEqual(['first', 'adjust direction', 'after steer']);
        });
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
        const onAuthFailure = vi.fn();
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
            onAuthFailure,
        });

        expect(onAuthFailure).toHaveBeenCalledWith('authentication_failed');
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
