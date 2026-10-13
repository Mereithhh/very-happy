import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerKillSessionHandler } from './registerKillSessionHandler';

describe('registerKillSessionHandler', () => {
    it('shares one idempotent termination path between archive events and the legacy RPC', async () => {
        let rpcHandler: (() => Promise<unknown>) | undefined;
        const rpc = {
            registerHandler: (_method: string, handler: () => Promise<unknown>) => {
                rpcHandler = handler;
            },
        };
        const events = new EventEmitter();
        const kill = vi.fn(async () => {});

        registerKillSessionHandler(rpc as any, kill, events);
        events.emit('archived');
        events.emit('archived');
        await rpcHandler?.();

        expect(kill).toHaveBeenCalledTimes(1);
    });
});

it('routes process termination through the same cleanup once and removes listeners', async () => {
    const before = process.listeners('SIGTERM');
    const kill = vi.fn(async () => {});
    const events = new EventEmitter();
    const dispose = registerKillSessionHandler({registerHandler:()=>{}} as any, kill, events, {processSignals:true});
    const added = process.listeners('SIGTERM').filter(fn=>!before.includes(fn));
    try {
        expect(added).toHaveLength(1);
        added[0]('SIGTERM');
        events.emit('archived');
        added[0]('SIGTERM');
        await Promise.resolve();
        expect(kill).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
    expect(process.listeners('SIGTERM')).toEqual(before);
    expect(events.listenerCount('archived')).toBe(0);
});

it('B-587 / AGENTS 7: a signal runs onSignal (offline), never the archive kill; still once', async () => {
    const before = process.listeners('SIGTERM');
    const kill = vi.fn(async () => {});
    const onSignal = vi.fn(async () => {});
    const events = new EventEmitter();
    const dispose = registerKillSessionHandler({registerHandler:()=>{}} as any, kill, events, {processSignals:true, onSignal});
    const added = process.listeners('SIGTERM').filter(fn=>!before.includes(fn));
    try {
        added[0]('SIGTERM');
        events.emit('archived');
        await Promise.resolve();
        expect(onSignal).toHaveBeenCalledTimes(1);
        expect(kill).not.toHaveBeenCalled();
    } finally { dispose(); }
});

it('B-587: with onSignal, the archived event and the killSession RPC still run the archive kill', async () => {
    const before = process.listeners('SIGTERM');
    for (const trigger of ['archived', 'rpc'] as const) {
        const kill = vi.fn(async () => {});
        const onSignal = vi.fn(async () => {});
        const events = new EventEmitter();
        const handlers: Record<string, () => unknown> = {};
        const dispose = registerKillSessionHandler({ registerHandler: (name: string, fn: () => unknown) => { handlers[name] = fn; } } as any, kill, events, { processSignals: true, onSignal });
        try {
            if (trigger === 'archived') events.emit('archived'); else await handlers.killSession();
            const added = process.listeners('SIGTERM').filter(fn => !before.includes(fn));
            added[0]('SIGTERM'); // a later signal is ignored
            await Promise.resolve();
            expect(kill).toHaveBeenCalledTimes(1);
            expect(onSignal).not.toHaveBeenCalled();
        } finally { dispose(); }
    }
});
