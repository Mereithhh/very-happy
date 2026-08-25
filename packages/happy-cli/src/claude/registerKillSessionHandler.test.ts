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
