import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rpcHandler } from './rpcHandler';

function fakeSocket() {
    const handlers = new Map<string, (...args: any[]) => any>();
    return {
        handlers,
        socket: {
            id: 'socket-1',
            on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
            emit: vi.fn(),
            join: vi.fn(),
            leave: vi.fn(),
        } as any,
    };
}

describe('RPC socket boundaries', () => {
    beforeEach(() => {
        delete process.env.RPC_MAX_PAYLOAD_BYTES;
        delete process.env.RPC_MAX_CALLS_PER_MINUTE;
    });

    it('rejects registration from user/session sockets', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, false);
        handlers.get('rpc-register')!({ method: 'machine:spawn' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'Machine-scoped connection required',
        });
    });

    it('allows registration from machine sockets only', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, true);
        handlers.get('rpc-register')!({ method: 'machine:spawn' });
        expect(socket.join).toHaveBeenCalledWith('rpc:account-1:machine:spawn');
    });

    it('rejects oversized RPC payloads before routing', async () => {
        process.env.RPC_MAX_PAYLOAD_BYTES = '64';
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, false);
        const callback = vi.fn();
        await handlers.get('rpc-call')!({ method: 'm', params: { value: 'x'.repeat(100) } }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC payload too large' });
    });
});
