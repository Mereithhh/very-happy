import { describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from './RpcHandlerManager';

function fakeSocket() {
    return { emit: vi.fn() } as any;
}

function acknowledgedSocket() {
    const listeners = new Map<string, Set<(data: any) => void>>();
    const socket: any = {
        on: vi.fn((event: string, listener: (data: any) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
        }),
        off: vi.fn((event: string, listener: (data: any) => void) => listeners.get(event)?.delete(listener)),
        emit: vi.fn((event: string, data: any) => {
            if (event === 'rpc-register') queueMicrotask(() => {
                for (const listener of listeners.get('rpc-registered') ?? []) listener(data);
            });
        }),
    };
    return socket;
}

describe('RpcHandlerManager multi-transport registration', () => {
    it('registers on control and relay independently and removes only the disconnected socket', () => {
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            logger: vi.fn(),
        });
        manager.registerHandler('open-terminal', vi.fn());

        const control = fakeSocket();
        const relay = fakeSocket();
        manager.onSocketConnect(control);
        manager.onSocketConnect(relay);
        expect(control.emit).toHaveBeenCalledWith('rpc-register', { method: 'machine-1:open-terminal' });
        expect(relay.emit).toHaveBeenCalledWith('rpc-register', { method: 'machine-1:open-terminal' });

        manager.onSocketDisconnect(control);
        manager.registerHandler('list-terminals', vi.fn());
        expect(control.emit).not.toHaveBeenCalledWith('rpc-register', { method: 'machine-1:list-terminals' });
        expect(relay.emit).toHaveBeenCalledWith('rpc-register', { method: 'machine-1:list-terminals' });
    });

    it('waits for every candidate registration acknowledgement', async () => {
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine-1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            logger: vi.fn(),
        });
        manager.registerHandler('open-terminal', vi.fn());
        manager.registerHandler('list-terminals', vi.fn());
        const candidate = acknowledgedSocket();

        await expect(manager.onSocketConnectAndWait(candidate, 100)).resolves.toBeUndefined();
        expect(candidate.emit).toHaveBeenCalledTimes(2);
        expect(candidate.off).toHaveBeenCalledWith('rpc-registered', expect.any(Function));
    });
});
