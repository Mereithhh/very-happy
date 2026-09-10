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
