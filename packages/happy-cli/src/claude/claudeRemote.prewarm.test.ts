import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import { logger } from '@/lib';
import { createClaudePrewarmLease, PrewarmHookGate } from './claudePrewarm';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const WEB: EnhancedMode = { permissionMode: 'default', appendSystemPrompt: 'WEB PROMPT' };

type FakeOpts = {
    supportedModels?: () => Promise<unknown>;
    mcpServerStatus?: () => Promise<unknown>;
    setPermissionMode?: (mode: string) => Promise<void>;
    setModel?: (model?: string) => Promise<void>;
};

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('claudeRemote prewarm (B-515)', () => {
    let events: string[];
    let perCall: FakeOpts[];
    let unhandled: unknown[];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

    beforeEach(() => {
        events = [];
        perCall = [];
        unhandled = [];
        process.on('unhandledRejection', onUnhandled);
        vi.mocked(query).mockReset();
        vi.mocked(query).mockImplementation((args: any) => {
            const index = vi.mocked(query).mock.calls.length - 1;
            const o = perCall[index] ?? {};
            events.push(`query#${index}`);
            return {
                supportedModels: o.supportedModels ?? (async () => [{ value: 'default', displayName: 'Default', description: '' }]),
                mcpServerStatus: vi.fn(o.mcpServerStatus ?? (async () => { events.push(`mcpServerStatus#${index}`); return []; })),
                setPermissionMode: vi.fn(async (mode: string) => { events.push(`setPermissionMode#${index}:${mode}`); await o.setPermissionMode?.(mode); }),
                setModel: vi.fn(async (model?: string) => { events.push(`setModel#${index}:${model}`); await o.setModel?.(model); }),
                interrupt: vi.fn(),
                async *[Symbol.asyncIterator]() {
                    for await (const m of args.prompt) {
                        events.push(`prompt#${index}:${m.message.content}`);
                        yield { type: 'system', subtype: 'init' };
                        yield { type: 'result', subtype: 'success' };
                    }
                },
            } as any;
        });
    });

    afterEach(() => {
        process.off('unhandledRejection', onUnhandled);
        vi.restoreAllMocks();
    });

    const makeLease = (over: { idleMs?: number; mode?: EnhancedMode } = {}) => {
        const gate = new PrewarmHookGate();
        const tag = gate.newTag();
        const slot = { path: '/slot', release: vi.fn() };
        const cleanupHookSettings = vi.fn();
        const log = vi.fn();
        const lease = createClaudePrewarmLease({
            mode: over.mode ?? WEB, hookSettingsPath: '/warm-hook-settings.json', tag, gate, slot,
            cleanupHookSettings, log, idleMs: over.idleMs ?? 60_000, adoptTimeoutMs: 200,
        });
        return { gate, tag, slot, cleanupHookSettings, log, lease };
    };

    const run = (lease: ReturnType<typeof makeLease>['lease'], first: Promise<{ message: string; mode: EnhancedMode } | null>, extra: Record<string, unknown> = {}) => {
        let n = 0;
        const onQueryReady = vi.fn();
        const onReady = vi.fn();
        const promise = claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/cold-hook-settings.json',
            nextMessage: async () => (n++ === 0 ? first : null),
            onReady, canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
            onSessionFound: vi.fn(), onMessage: vi.fn(), onQueryReady,
            prewarm: lease,
            ...extra,
        });
        return { promise, onQueryReady, onReady };
    };

    it('starts query() before the first message and adopts it: one process, prompt after a liveness probe, controls only on adoption', async () => {
        const debug = vi.spyOn(logger, 'debug');
        const { lease, gate, tag, slot, cleanupHookSettings } = makeLease();
        const first = deferred<{ message: string; mode: EnhancedMode }>();
        const { promise, onQueryReady } = run(lease, first.promise);
        await tick();

        expect(query).toHaveBeenCalledTimes(1);
        const warmOptions = vi.mocked(query).mock.calls[0][0].options!;
        expect(warmOptions.settingsPath).toBe('/warm-hook-settings.json');
        expect(warmOptions.appendSystemPrompt).toMatch(/^WEB PROMPT\n\n/);
        expect(warmOptions.permissionMode).toBe('default');
        expect(onQueryReady).not.toHaveBeenCalled();
        expect(gate.accepts(tag)).toBe(false);

        first.resolve({ message: 'hello', mode: { ...WEB } });
        await promise;

        expect(query).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['query#0', 'mcpServerStatus#0', 'prompt#0:hello']);
        expect(onQueryReady).toHaveBeenCalledOnce();
        expect(gate.accepts(tag)).toBe(true);
        expect(slot.release).toHaveBeenCalledOnce();
        expect(cleanupHookSettings).not.toHaveBeenCalled();
        const lines = debug.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.startsWith('[CLAUDE PREWARM] started'))).toBe(true);
        expect(lines.some((l) => l.startsWith('[CLAUDE PREWARM] adopted'))).toBe(true);
        expect(lines.some((l) => l.startsWith('[CLAUDE TIMING] turn=1') && l.endsWith('prewarm=adopted'))).toBe(true);
        expect(unhandled).toEqual([]);
    });

    it('enforces the exact permission mode (awaited) before pushing the prompt', async () => {
        const { lease } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: 'go', mode: { ...WEB, permissionMode: 'bypassPermissions' } }));
        await promise;
        expect(query).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['query#0', 'setPermissionMode#0:bypassPermissions', 'prompt#0:go']);
    });

    it('moves the model live before the prompt', async () => {
        const { lease } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: 'go', mode: { ...WEB, model: 'opus' } }));
        await promise;
        expect(events).toEqual(['query#0', 'mcpServerStatus#0', 'setModel#0:opus', 'prompt#0:go']);
    });

    it('a prediction miss closes the warm process and takes the cold path with the real mode', async () => {
        const { lease, slot, cleanupHookSettings, log } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: 'go', mode: { ...WEB, effort: 'high' } }));
        await promise;
        expect(query).toHaveBeenCalledTimes(2);
        const [warmCall, coldCall] = vi.mocked(query).mock.calls;
        expect(warmCall[0].options!.abort!.aborted).toBe(true);
        expect(coldCall[0].options).toEqual(expect.objectContaining({ effort: 'high', settingsPath: '/cold-hook-settings.json' }));
        expect(events).toEqual(['query#0', 'query#1', 'prompt#1:go']);
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(mode-mismatch)');
        expect(slot.release).toHaveBeenCalledOnce();
        expect(cleanupHookSettings).toHaveBeenCalledOnce();
    });

    it('waits for a handshake still in flight instead of cold-starting', async () => {
        const handshake = deferred<unknown>();
        perCall[0] = { supportedModels: () => handshake.promise };
        const { lease } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: 'early', mode: { ...WEB } }));
        await tick(20);
        expect(query).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['query#0']);
        handshake.resolve([]);
        await promise;
        expect(query).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['query#0', 'mcpServerStatus#0', 'prompt#0:early']);
    });

    it('a failed handshake is discarded at once (no unhandled rejection) and the message goes cold', async () => {
        perCall[0] = { supportedModels: async () => { throw new Error('Claude Code process exited with code 1'); } };
        const { lease, log, slot } = makeLease();
        const first = deferred<{ message: string; mode: EnhancedMode }>();
        const { promise } = run(lease, first.promise);
        await tick(10);
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(handshake-failed)');
        expect(slot.release).toHaveBeenCalledOnce();
        first.resolve({ message: 'go', mode: { ...WEB } });
        await promise;
        expect(query).toHaveBeenCalledTimes(2);
        expect(events).toEqual(['query#0', 'query#1', 'prompt#1:go']);
        expect(unhandled).toEqual([]);
    });

    it('a warm child that died while idle: session survives (no rejection escapes), first message falls back to cold', async () => {
        perCall[0] = { mcpServerStatus: async () => { throw new Error('Query closed before response received'); } };
        const { lease, log } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: 'go', mode: { ...WEB } }));
        await expect(promise).resolves.toBeUndefined();
        expect(query).toHaveBeenCalledTimes(2);
        expect(events).toEqual(['query#0', 'query#1', 'prompt#1:go']);
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(not-alive)');
        await tick(10);
        expect(unhandled).toEqual([]);
    });

    it('a wedged warm child (probe never answers) is abandoned after the adopt timeout', async () => {
        perCall[0] = { mcpServerStatus: () => new Promise(() => {}) };
        const { lease, log } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: 'go', mode: { ...WEB } }));
        await promise;
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(not-alive)');
        expect(events).toEqual(['query#0', 'query#1', 'prompt#1:go']);
    });

    it('closes the warm process after the idle limit; the late message goes cold', async () => {
        const { lease, log } = makeLease({ idleMs: 30 });
        const first = deferred<{ message: string; mode: EnhancedMode }>();
        const { promise } = run(lease, first.promise);
        await tick(80);
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(idle)');
        expect(vi.mocked(query).mock.calls[0][0].options!.abort!.aborted).toBe(true);
        first.resolve({ message: 'late', mode: { ...WEB } });
        await promise;
        expect(events).toEqual(['query#0', 'query#1', 'prompt#1:late']);
    });

    it('/clear as the first message discards the warm process and spawns nothing', async () => {
        const { lease, log } = makeLease();
        const { promise, onReady } = run(lease, Promise.resolve({ message: '/clear', mode: { ...WEB } }), { onSessionReset: vi.fn() });
        await promise;
        expect(query).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(clear)');
        expect(onReady).toHaveBeenCalledOnce();
    });

    it('/compact as the first message never runs in the warm process', async () => {
        const { lease, log } = makeLease();
        const { promise } = run(lease, Promise.resolve({ message: '/compact', mode: { ...WEB } }), { onCompletionEvent: vi.fn() });
        await promise;
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(compact)');
        expect(events).toEqual(['query#0', 'query#1', 'prompt#1:/compact']);
    });

    it('wrapper exit before any message closes the warm process', async () => {
        const { lease, log } = makeLease();
        const { promise } = run(lease, Promise.resolve(null));
        await promise;
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(exit)');
        expect(vi.mocked(query).mock.calls[0][0].options!.abort!.aborted).toBe(true);
    });

    it('the launcher abort reaches the warm process', async () => {
        const { lease } = makeLease();
        const controller = new AbortController();
        const first = deferred<{ message: string; mode: EnhancedMode } | null>();
        const { promise } = run(lease, first.promise, { signal: controller.signal });
        await tick();
        controller.abort();
        expect(vi.mocked(query).mock.calls[0][0].options!.abort!.aborted).toBe(true);
        first.resolve(null);
        await promise;
    });
});
