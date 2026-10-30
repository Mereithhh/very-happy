import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';
import { createRetiredModels } from './claudeRetiredModel';

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

    it('keeps runtime controls blocked until the permission callback response can flush', async () => {
        let controls!: {canControl:()=>boolean};
        let callbackDone!:()=>void;
        const pending=new Promise<void>(resolve=>{callbackDone=resolve;});
        vi.mocked(query).mockImplementation((args:any)=>({
            async *[Symbol.asyncIterator]() {
                expect(controls.canControl()).toBe(true);
                const response=args.options.canCallTool('Bash',{}, {signal:new AbortController().signal,toolUseID:'tool'});
                expect(controls.canControl()).toBe(false);
                callbackDone(); await response;
                expect(controls.canControl()).toBe(false);
                await new Promise(resolve=>setImmediate(resolve));
                expect(controls.canControl()).toBe(true);
            },
        } as any));
        let n=0;
        await claudeRemote({sessionId:null,path:process.cwd(),allowedTools:[],hookSettingsPath:'/unused-test-settings.json',
            nextMessage:async()=>++n===1?{message:'hello',mode}:null,onReady:vi.fn(),
            canCallTool:async()=>{await pending;return {behavior:'allow',updatedInput:{}};},
            onQueryReady:q=>{controls=q;},isAborted:()=>false,onSessionFound:vi.fn(),onMessage:vi.fn()});
    });

    it('exposes /btw as a side_question control request on the live Query (B-482)', async () => {
        let controls!: Parameters<NonNullable<Parameters<typeof claudeRemote>[0]['onQueryReady']>>[0];
        const request = vi.fn(async () => ({ subtype: 'success', request_id: 'r1', response: { response: 'live answer', synthetic: false } }));
        vi.mocked(query).mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
                const controller = new AbortController();
                await expect(controls.sideQuestion({ question: 'what now?', history: [{ question: 'a', response: 'b' }] }, controller.signal))
                    .resolves.toEqual({ response: 'live answer', synthetic: false });
                expect(request).toHaveBeenCalledWith(
                    { subtype: 'side_question', question: 'what now?', history: [{ question: 'a', response: 'b' }] },
                    { signal: controller.signal },
                );
            },
            request,
        } as any));
        let n = 0;
        await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/unused-test-settings.json',
            nextMessage: async () => ++n === 1 ? { message: 'hello', mode } : null, onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onQueryReady: (q) => { controls = q; }, isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn() });
        expect(request).toHaveBeenCalledTimes(1);
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

    describe('start-up args (--resume) are spent only by a launch that starts Claude (QA21)', () => {
        const base = () => ({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/unused-test-settings.json',
            onReady: vi.fn(), canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
            onSessionFound: vi.fn(), onMessage: vi.fn(),
        });

        it('a launch whose first message was parked (isolated /compact after a restart) leaves them', async () => {
            const onStartArgsUsed = vi.fn();
            await claudeRemote({ ...base(), nextMessage: async () => null, onStartArgsUsed });
            expect(onStartArgsUsed).not.toHaveBeenCalled();
            expect(query).not.toHaveBeenCalled();
        });

        it('the launch that spawns Claude on them reports them used before query()', async () => {
            const order: string[] = [];
            vi.mocked(query).mockImplementation(() => { order.push('query'); return { async *[Symbol.asyncIterator]() {} } as any; });
            let n = 0;
            await claudeRemote({ ...base(), nextMessage: async () => ++n === 1 ? { message: '/compact', mode } : null,
                onStartArgsUsed: () => { order.push('used'); } });
            expect(order).toEqual(['used', 'query']);
        });

        it('/clear drops them on purpose', async () => {
            const onStartArgsUsed = vi.fn();
            await claudeRemote({ ...base(), nextMessage: async () => ({ message: '/clear', mode }), onSessionReset: vi.fn(), onStartArgsUsed });
            expect(onStartArgsUsed).toHaveBeenCalledOnce();
            expect(query).not.toHaveBeenCalled();
        });
    });

    it('reports a refused /compact as not compacted (status frame carries the verdict; result is success)', async () => {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'status', status: 'compacting' };
                yield { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' };
                yield { type: 'result', subtype: 'success', num_turns: 0, result: '' };
            },
        } as any);
        const onCompletionEvent = vi.fn();
        let n = 0;
        await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/unused-test-settings.json',
            nextMessage: async () => ++n === 1 ? { message: '/compact', mode } : null, onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
            onCompletionEvent });
        expect(onCompletionEvent.mock.calls.map(([m]) => m)).toEqual(['Compaction started', 'Compaction failed: Not enough messages to compact.']);
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
            supportedModels: vi.fn(async () => [
                { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'max'] },
                { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
            ]),
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
            models: [
                { code: 'sonnet', resolvedModel: 'claude-sonnet-5', value: 'Sonnet', description: '', reasoningEfforts: ['low', 'max'] },
                { code: 'haiku', resolvedModel: undefined, value: 'Haiku', description: '', reasoningEfforts: [] },
            ],
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

    /**
     * B-631: the wrapper reads Claude Code's own turn-over signal and its queue
     * bookkeeping (spec specs/2026-10-claude-wrapper-orca-align.md). Frame shapes
     * are the ones Claude Code 2.1.296 emitted in the 2026-10-19 probe.
     */
    describe('Orca follow-ups (B-634)', () => {
        const base = () => ({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onMessage: vi.fn(),
            onReady: vi.fn(),
        });

        it('③ model_not_found on a root reply: back to the default now, and the retired id is not sent again', async () => {
            const setModel = vi.fn(async () => {});
            const observed: unknown[] = [];
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                setModel,
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observed.push((await input.next()).value.message.content);
                    yield { type: 'assistant', parent_tool_use_id: null, error: 'model_not_found', message: { role: 'assistant', content: [{ type: 'text', text: 'model gone' }] } };
                    yield { type: 'result', subtype: 'success' };
                    observed.push((await input.next()).value.message.content);
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));
            const retiredModels = createRetiredModels();
            const onCompletionEvent = vi.fn();
            let n = 0;
            await claudeRemote({
                ...base(),
                retiredModels,
                onCompletionEvent,
                // The web keeps sending its pick with every message.
                nextMessage: async () => (n++ < 2 ? { message: `turn ${n}`, mode: { ...mode, model: 'claude-gone-1' } } : null),
            });
            expect(vi.mocked(query).mock.calls[0][0].options).toEqual(expect.objectContaining({ model: 'claude-gone-1' }));
            expect(setModel.mock.calls).toEqual([[undefined]]);
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('"claude-gone-1" is no longer available'));
            expect(retiredModels.effective('claude-gone-1')).toBeUndefined();
            expect(observed).toEqual(['turn 1', 'turn 2']);
        });

        it('③ a sub-agent\'s model_not_found does not retire the session model', async () => {
            const setModel = vi.fn(async () => {});
            vi.mocked(query).mockImplementation(() => ({
                setPermissionMode: vi.fn(),
                setModel,
                async *[Symbol.asyncIterator]() {
                    yield { type: 'assistant', parent_tool_use_id: 'toolu_1', error: 'model_not_found', message: { role: 'assistant', content: [] } };
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));
            const retiredModels = createRetiredModels();
            let n = 0;
            await claudeRemote({ ...base(), retiredModels, nextMessage: async () => (n++ === 0 ? { message: 'hi', mode: { ...mode, model: 'opus' } } : null) });
            expect(setModel).not.toHaveBeenCalled();
            expect(retiredModels.effective('opus')).toBe('opus');
        });

        const UUID_A = '11111111-1111-4111-8111-111111111111';
        const UUID_B = '22222222-2222-4222-8222-222222222222';

        it('② the process dies with a pushed message never started: reported as unconfirmed with what was sent (not aborted)', async () => {
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    await input.next();
                    yield { type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] };
                    yield { type: 'command_lifecycle', command_uuid: UUID_A, state: 'started' };
                    yield { type: 'command_lifecycle', command_uuid: UUID_A, state: 'completed' };
                    yield { type: 'result', subtype: 'success' };
                    await input.next(); // the second prompt is written…
                    throw new Error('Claude Code process exited with code 1'); // …and the process dies before reading it
                },
            } as any));
            const onCommandsUnconfirmed = vi.fn();
            let n = 0;
            await expect(claudeRemote({
                ...base(),
                onCommandsUnconfirmed,
                nextMessage: async () => [{ message: 'first', mode, uuid: UUID_A }, { message: 'second', mode, uuid: UUID_B }][n++] ?? null,
            })).rejects.toThrow('exited with code 1');
            expect(onCommandsUnconfirmed).toHaveBeenCalledTimes(1);
            expect(onCommandsUnconfirmed).toHaveBeenCalledWith([{ uuid: UUID_B, payload: { message: 'second', mode } }], { aborted: false });
        });

        it('② a CLI without lifecycle frames reports nothing (it could never confirm anything)', async () => {
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    await args.prompt[Symbol.asyncIterator]().next();
                    yield { type: 'system', subtype: 'init', capabilities: [] };
                    throw new Error('Claude Code process exited with code 1');
                },
            } as any));
            const onCommandsUnconfirmed = vi.fn();
            let n = 0;
            await expect(claudeRemote({ ...base(), onCommandsUnconfirmed, nextMessage: async () => (n++ === 0 ? { message: 'hi', mode, uuid: UUID_A } : null) })).rejects.toThrow();
            expect(onCommandsUnconfirmed).not.toHaveBeenCalled();
        });
    });

    describe('idle turn end, interrupt receipts and steer lifecycle (B-631)', () => {
        const STEER_A = '11111111-1111-4111-8111-111111111111';
        const STEER_B = '22222222-2222-4222-8222-222222222222';
        const state = (s: 'idle' | 'running') => ({ type: 'system', subtype: 'session_state_changed', state: s });
        const lifecycle = (command_uuid: string, s: string) => ({ type: 'command_lifecycle', command_uuid, state: s, uuid: 'f', session_id: 's' });
        const baseOpts = () => ({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onMessage: vi.fn(),
        });

        it('an idle with no result ends the turn: thinking off, closed without a verdict, next message pulled; the idle after a result is not a second end', async () => {
            const observedInputs: string[] = [];
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observedInputs.push((await input.next()).value.message.content);
                    yield state('running');
                    yield { type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] };
                    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'half an answer' }] } };
                    // The model request threw: Claude Code reports no result, only that it is idle.
                    yield state('idle');
                    observedInputs.push((await input.next()).value.message.content);
                    yield state('running');
                    yield { type: 'result', subtype: 'success' };
                    yield state('idle');
                    expect((await input.next()).done).toBe(true);
                },
            } as any));

            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'first', mode })
                .mockResolvedValueOnce({ message: 'second', mode })
                .mockResolvedValue(null);
            const onReady = vi.fn();
            const onThinkingChange = vi.fn();
            await claudeRemote({ ...baseOpts(), nextMessage, onReady, onThinkingChange });

            expect(observedInputs).toEqual(['first', 'second']);
            // Turn 1 ended by idle (no verdict), turn 2 by its result — and the
            // trailing idle did not end anything a third time.
            expect(onReady.mock.calls).toEqual([[undefined], [expect.objectContaining({ type: 'result' })]]);
            expect(onThinkingChange.mock.calls.map(([thinking]) => thinking)).toEqual([true, false, true, false]);
            expect(nextMessage).toHaveBeenCalledTimes(3);
        });

        it('neither the late idle of the previous turn nor a stray idle ends the turn that was pushed but not yet announced (review 2)', async () => {
            const observedInputs: string[] = [];
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observedInputs.push((await input.next()).value.message.content);
                    yield state('running');
                    yield { type: 'result', subtype: 'success' };
                    // The wrapper pulls and pushes the second prompt here, before
                    // reading the idle that belongs to the first result.
                    observedInputs.push((await input.next()).value.message.content);
                    yield state('idle');   // idle(N), owed to the result above
                    // A stray idle (the CLI's notifier has several emitters and no
                    // same-state dedupe): N+1 is pushed, not announced — nothing to end.
                    yield state('idle');
                    yield state('running');
                    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } };
                    yield { type: 'result', subtype: 'success' };
                    yield state('idle');
                    expect((await input.next()).done).toBe(true);
                },
            } as any));

            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'first', mode })
                .mockResolvedValueOnce({ message: 'second', mode })
                .mockResolvedValue(null);
            const onReady = vi.fn();
            const onThinkingChange = vi.fn();
            await claudeRemote({ ...baseOpts(), nextMessage, onReady, onThinkingChange });

            expect(observedInputs).toEqual(['first', 'second']);
            expect(onReady).toHaveBeenCalledTimes(2);
            expect(onReady.mock.calls.every(([result]) => result?.type === 'result')).toBe(true);
            expect(onThinkingChange.mock.calls.map(([thinking]) => thinking)).toEqual([true, false, true, false]);
        });

        /** Drives one Query to its init, hands the controls to `act`, then lets the turn end. */
        async function withLiveTurn(opts: {
            capabilities: string[];
            interrupt: ReturnType<typeof vi.fn>;
            cancelAsyncMessage?: ReturnType<typeof vi.fn>;
            /** Frames yielded after `act` released the turn, before its result. */
            afterAct?: () => unknown[];
            act: (controls: any, observedInputs: any[]) => Promise<void>;
        }) {
            const observedInputs: any[] = [];
            let controls: any;
            let release!: () => void;
            const released = new Promise<void>((resolve) => { release = resolve; });
            const onMessage = vi.fn();
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                interrupt: opts.interrupt,
                ...(opts.cancelAsyncMessage ? { cancelAsyncMessage: opts.cancelAsyncMessage } : {}),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observedInputs.push((await input.next()).value);
                    yield { type: 'system', subtype: 'init', capabilities: opts.capabilities };
                    await released;
                    for (const frame of opts.afterAct?.() ?? []) yield frame;
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));
            const onCommandsDropped = vi.fn();
            const running = claudeRemote({
                ...baseOpts(),
                onMessage,
                nextMessage: vi.fn().mockResolvedValueOnce({ message: 'first', mode }).mockResolvedValue(null),
                onReady: vi.fn(),
                onThinkingChange: vi.fn(),
                onQueryReady: (q) => { controls = q; },
                onCommandsDropped,
            });
            await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ subtype: 'init' })));
            await opts.act(controls, observedInputs);
            release();
            await running;
            return { onCommandsDropped, observedInputs };
        }

        it('Stop on a CLI with interrupt_cancel_queued_v1 sweeps the queue in one round trip and tombstones the steers it swept', async () => {
            const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [STEER_A, 'someone-elses-prompt'] }));
            const cancelAsyncMessage = vi.fn();
            const { onCommandsDropped, observedInputs } = await withLiveTurn({
                capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
                interrupt,
                cancelAsyncMessage,
                act: async (controls) => {
                    controls.steer('swept before the model saw it', mode, STEER_A);
                    controls.steer('untracked: not a uuid', mode, 'web-local-key-7');
                    await controls.interrupt();
                },
            });
            expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true });
            expect(cancelAsyncMessage).not.toHaveBeenCalled();
            expect(onCommandsDropped).toHaveBeenCalledTimes(1);
            expect(onCommandsDropped).toHaveBeenCalledWith([STEER_A]);
            expect(observedInputs[0]).toMatchObject({ message: { content: 'first' } });
        });

        it('without cancel_queued, each still_queued steer is withdrawn by uuid and only a confirmed withdrawal is reported', async () => {
            const interrupt = vi.fn(async () => ({ still_queued: [STEER_A, STEER_B, 'someone-elses-prompt'] }));
            // A: still in the queue → withdrawn. B: the drain loop already took it → it runs.
            const cancelAsyncMessage = vi.fn(async (uuid: string) => uuid === STEER_A);
            const { onCommandsDropped } = await withLiveTurn({
                capabilities: ['interrupt_receipt_v1'],
                interrupt,
                cancelAsyncMessage,
                act: async (controls) => {
                    controls.steer('a', mode, STEER_A);
                    controls.steer('b', mode, STEER_B);
                    await controls.interrupt();
                },
            });
            expect(interrupt).toHaveBeenCalledWith(undefined);
            expect(cancelAsyncMessage.mock.calls.map(([uuid]) => uuid)).toEqual([STEER_A, STEER_B]);
            expect(onCommandsDropped).toHaveBeenCalledTimes(1);
            expect(onCommandsDropped).toHaveBeenCalledWith([STEER_A]);
        });

        it('an older CLI answers interrupt without a receipt: nothing is swept, nothing is reported', async () => {
            const interrupt = vi.fn(async () => undefined);
            const cancelAsyncMessage = vi.fn();
            const { onCommandsDropped } = await withLiveTurn({
                capabilities: [],
                interrupt,
                cancelAsyncMessage,
                act: async (controls) => {
                    controls.steer('a', mode, STEER_A);
                    await controls.interrupt();
                },
            });
            expect(interrupt).toHaveBeenCalledWith(undefined);
            expect(cancelAsyncMessage).not.toHaveBeenCalled();
            expect(onCommandsDropped).not.toHaveBeenCalled();
        });

        it('command_lifecycle: a steer cancelled before it started is reported once; one that started is settled silently', async () => {
            const { onCommandsDropped } = await withLiveTurn({
                capabilities: ['msg_lifecycle_v1'],
                interrupt: vi.fn(),
                afterAct: () => [
                    lifecycle(STEER_A, 'queued'),
                    lifecycle(STEER_B, 'queued'),
                    lifecycle(STEER_B, 'started'),
                    lifecycle(STEER_A, 'cancelled'),
                    lifecycle(STEER_A, 'cancelled'),
                    lifecycle(STEER_B, 'cancelled'),
                    lifecycle('someone-elses-prompt', 'cancelled'),
                ],
                act: async (controls) => {
                    controls.steer('a', mode, STEER_A);
                    controls.steer('b', mode, STEER_B);
                },
            });
            expect(onCommandsDropped).toHaveBeenCalledTimes(1);
            expect(onCommandsDropped).toHaveBeenCalledWith([STEER_A]);
        });

        it('stamps the steer with the localKey as its transcript uuid, keeping priority now', async () => {
            const observedInputs: any[] = [];
            let controls: any;
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                interrupt: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observedInputs.push((await input.next()).value);
                    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } };
                    observedInputs.push((await input.next()).value);
                    observedInputs.push((await input.next()).value);
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));
            const running = claudeRemote({
                ...baseOpts(),
                nextMessage: vi.fn().mockResolvedValueOnce({ message: 'first', mode }).mockResolvedValue(null),
                onReady: vi.fn(),
                onThinkingChange: vi.fn(),
                onQueryReady: (q) => { controls = q; },
            });
            await vi.waitFor(() => expect(observedInputs).toHaveLength(1));
            controls.steer('tracked', mode, STEER_A);
            controls.steer('untracked', mode, 'web-local-key-7');
            await running;

            expect(observedInputs[1]).toMatchObject({ type: 'user', priority: 'now', uuid: STEER_A, message: { content: 'tracked' } });
            expect(observedInputs[2]).toMatchObject({ type: 'user', priority: 'now', message: { content: 'untracked' } });
            expect(observedInputs[2]).not.toHaveProperty('uuid');
        });

        it('a prompt pushed behind the running turn and swept by Stop gets the B-332 tombstone, exactly like a steer (review 1)', async () => {
            const PROMPT_2 = '33333333-3333-4333-8333-333333333333';
            const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [PROMPT_2] }));
            const observedInputs: any[] = [];
            let controls: any;
            let release!: () => void;
            const released = new Promise<void>((resolve) => { release = resolve; });
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                interrupt,
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    observedInputs.push((await input.next()).value);
                    yield { type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] };
                    // Turn 1 ends the way a pre-empted turn does; the wrapper pulls
                    // and pushes PROMPT_2, which the CLI only queues while the
                    // pre-empting steer's turn is still running.
                    yield { type: 'result', subtype: 'success' };
                    observedInputs.push((await input.next()).value);
                    await released;
                    yield { type: 'result', subtype: 'success' };
                },
            } as any));
            const onCommandsDropped = vi.fn();
            const running = claudeRemote({
                ...baseOpts(),
                nextMessage: vi.fn()
                    .mockResolvedValueOnce({ message: 'first', mode })
                    .mockResolvedValueOnce({ message: 'second', mode, uuid: PROMPT_2 })
                    .mockResolvedValue(null),
                onReady: vi.fn(),
                onThinkingChange: vi.fn(),
                onQueryReady: (q) => { controls = q; },
                onCommandsDropped,
            });
            await vi.waitFor(() => expect(observedInputs).toHaveLength(2));
            expect(observedInputs[1]).toMatchObject({ uuid: PROMPT_2, message: { content: 'second' } });
            await controls.interrupt();
            expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true });
            expect(onCommandsDropped).toHaveBeenCalledWith([PROMPT_2]);
            release();
            await running;
        });

        it('a setModel the CLI never answers is given up after 30 s: the turn runs on the loaded model, the user is told, and the next boundary re-sends (review 4)', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            try {
                const observed: string[] = [];
                const setModelCalls: Array<string | undefined> = [];
                const setModel = vi.fn((model?: string) => {
                    setModelCalls.push(model);
                    // The first request hangs (a wedged CLI); later ones answer.
                    return setModelCalls.length === 1 ? new Promise<void>(() => {}) : Promise.resolve();
                });
                vi.mocked(query).mockImplementation((args: any) => ({
                    setPermissionMode: vi.fn(),
                    setModel,
                    async *[Symbol.asyncIterator]() {
                        const input = args.prompt[Symbol.asyncIterator]();
                        for (let turn = 0; turn < 3; turn += 1) {
                            observed.push((await input.next()).value.message.content);
                            yield { type: 'result', subtype: 'success' };
                        }
                        expect((await input.next()).done).toBe(true);
                    },
                } as any));
                const onCompletionEvent = vi.fn();
                const running = claudeRemote({
                    ...baseOpts(),
                    nextMessage: vi.fn()
                        .mockResolvedValueOnce({ message: 'turn 0', mode: { ...mode, model: 'opus' } })
                        .mockResolvedValueOnce({ message: 'turn 1', mode: { ...mode, model: 'sonnet' } })
                        .mockResolvedValueOnce({ message: 'turn 2', mode: { ...mode, model: 'sonnet' } })
                        .mockResolvedValue(null),
                    onReady: vi.fn(),
                    onThinkingChange: vi.fn(),
                    onCompletionEvent,
                });
                await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
                expect(observed).toEqual(['turn 0']);   // turn 1 waits for the switch…
                await vi.advanceTimersByTimeAsync(30_000);
                await running;
                // …until the budget runs out: told, and run on the loaded model.
                expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('timed out after 30000ms'));
                expect(observed).toEqual(['turn 0', 'turn 1', 'turn 2']);
                // turn 2 asks for the same model turn 1 did; normally skipped as
                // "unchanged", but the first request never answered (it may have
                // landed late), so the boundary re-sends it.
                expect(setModelCalls).toEqual(['sonnet', 'sonnet']);
            } finally {
                vi.useRealTimers();
            }
        });

        it('a turn that ends by idle after an authentication_failed assistant frame still recycles the poisoned Query (review 5)', async () => {
            vi.mocked(query).mockImplementation((args: any) => ({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    const input = args.prompt[Symbol.asyncIterator]();
                    await input.next();
                    yield state('running');
                    yield { type: 'system', subtype: 'init', capabilities: [] };
                    yield { type: 'assistant', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate' }] } };
                    yield state('idle');   // no result frame at all
                    // The Query was ended instead of being fed the next prompt.
                    expect((await input.next()).done).toBe(true);
                },
            } as any));
            const nextMessage = vi.fn().mockResolvedValueOnce({ message: 'first', mode }).mockResolvedValue({ message: 'never pushed', mode });
            const onAuthFailure = vi.fn();
            const onCompletionEvent = vi.fn();
            const onReady = vi.fn();
            await claudeRemote({ ...baseOpts(), nextMessage, onReady, onThinkingChange: vi.fn(), onAuthFailure, onCompletionEvent });

            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onReady).toHaveBeenCalledWith(undefined);
            expect(onAuthFailure).toHaveBeenCalledWith('authentication_failed');
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('could not refresh its OAuth session'));
            expect(nextMessage).toHaveBeenCalledTimes(1);
        });
    });
});
