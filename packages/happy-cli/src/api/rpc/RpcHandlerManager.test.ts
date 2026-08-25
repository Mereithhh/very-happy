import { describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from './RpcHandlerManager';

function fakeSocket() {
    return { emit: vi.fn() } as any;
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
});
