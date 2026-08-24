import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rpcHandler, rpcMetricMethod } from './rpcHandler';
import { AccountTerminalRateLimiter, relayPayloadBytes } from './terminalRateLimit';

function fakeSocket(id = 'socket-1') {
    const handlers = new Map<string, (...args: any[]) => any>();
    return {
        handlers,
        socket: {
            id,
            on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
            emit: vi.fn(),
            join: vi.fn(),
            leave: vi.fn(),
            disconnect: vi.fn(),
        } as any,
    };
}

describe('RPC socket boundaries', () => {
    beforeEach(() => {
        delete process.env.RPC_MAX_PAYLOAD_BYTES;
        delete process.env.RPC_MAX_CALLS_PER_MINUTE;
        delete process.env.RPC_MAX_REGISTERED_METHODS_PER_SOCKET;
    });

    it('rejects registration from user/session sockets', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any);
        handlers.get('rpc-register')!({ method: 'machine:spawn' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'Machine-scoped connection required',
        });
    });

    it('allows registration from machine sockets only', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'machine-1');
        handlers.get('rpc-register')!({ method: 'machine-1:spawn' });
        expect(socket.join).toHaveBeenCalledWith('rpc:account-1:machine-1:spawn');
    });

    it('rejects a machine daemon registering another machine scope', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'machine-1');
        handlers.get('rpc-register')!({ method: 'machine-2:spawn' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'Method is outside authenticated machine scope',
        });
    });

    it('bounds unique registered rooms, deduplicates retries, and disconnects on overflow', () => {
        process.env.RPC_MAX_REGISTERED_METHODS_PER_SOCKET = '2';
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'machine-1');
        handlers.get('rpc-register')!({ method: 'machine-1:first' });
        handlers.get('rpc-register')!({ method: 'machine-1:first' });
        handlers.get('rpc-register')!({ method: 'machine-1:second' });
        handlers.get('rpc-register')!({ method: 'machine-1:overflow' });

        expect(socket.join).toHaveBeenCalledTimes(2);
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'RPC registration limit reached',
        });
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('releases a registration slot when a method is unregistered', () => {
        process.env.RPC_MAX_REGISTERED_METHODS_PER_SOCKET = '1';
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'machine-1');
        handlers.get('rpc-register')!({ method: 'machine-1:first' });
        handlers.get('rpc-unregister')!({ method: 'machine-1:first' });
        handlers.get('rpc-register')!({ method: 'machine-1:second' });

        expect(socket.join).toHaveBeenCalledTimes(2);
        expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('rejects oversized RPC payloads before routing', async () => {
        process.env.RPC_MAX_PAYLOAD_BYTES = '64';
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any);
        const callback = vi.fn();
        await handlers.get('rpc-call')!({ method: 'm', params: { value: 'x'.repeat(100) } }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC payload too large' });
    });

    it('rejects non-string methods without throwing from metric recording', async () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any);
        for (const method of [123, { nested: true }, null]) {
            const callback = vi.fn();
            await expect(handlers.get('rpc-call')!({ method, params: {} }, callback)).resolves.toBeUndefined();
            expect(callback).toHaveBeenCalledWith({ ok: false, error: 'Invalid parameters: method is required' });
        }
    });

    it('bounds metric label cardinality to known, other, and invalid values', () => {
        expect(rpcMetricMethod('machine-1:uploadFileChunk')).toBe('uploadFileChunk');
        expect(rpcMetricMethod(123)).toBe('invalid');
        const labels = new Set(Array.from({ length: 1_000 }, (_, index) => rpcMetricMethod(`machine-1:attacker-${index}`)));
        expect(labels).toEqual(new Set(['other']));
    });

    it('shares the RPC byte/event allowance across sockets for one account', async () => {
        const request = { method: '', params: { value: 'charged-before-validation' } };
        const cost = relayPayloadBytes(request);
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1,
            burstBytes: cost,
            eventsPerSecond: 1,
            burstEvents: 1,
        });
        const first = fakeSocket('socket-a');
        const second = fakeSocket('socket-b');
        const otherAccount = fakeSocket('socket-c');
        rpcHandler('account-1', first.socket, {} as any, undefined, limiter);
        rpcHandler('account-1', second.socket, {} as any, undefined, limiter);
        rpcHandler('account-2', otherAccount.socket, {} as any, undefined, limiter);

        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        const otherCallback = vi.fn();
        await first.handlers.get('rpc-call')!(request, firstCallback);
        await second.handlers.get('rpc-call')!(request, secondCallback);
        await otherAccount.handlers.get('rpc-call')!(request, otherCallback);

        expect(firstCallback).toHaveBeenCalledWith({ ok: false, error: 'Invalid parameters: method is required' });
        expect(secondCallback).toHaveBeenCalledWith({ ok: false, error: 'RPC account rate limit reached' });
        expect(otherCallback).toHaveBeenCalledWith({ ok: false, error: 'Invalid parameters: method is required' });
    });

    it('charges oversized calls before the per-call payload rejection', async () => {
        process.env.RPC_MAX_PAYLOAD_BYTES = '64';
        const request = { method: 'machine-1:test', params: { value: 'x'.repeat(100) } };
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1,
            burstBytes: relayPayloadBytes(request),
            eventsPerSecond: 1,
            burstEvents: 1,
        });
        const first = fakeSocket('oversize-a');
        const second = fakeSocket('oversize-b');
        rpcHandler('account-1', first.socket, {} as any, undefined, limiter);
        rpcHandler('account-1', second.socket, {} as any, undefined, limiter);

        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        await first.handlers.get('rpc-call')!(request, firstCallback);
        await second.handlers.get('rpc-call')!(request, secondCallback);

        expect(firstCallback).toHaveBeenCalledWith({ ok: false, error: 'RPC payload too large' });
        expect(secondCallback).toHaveBeenCalledWith({ ok: false, error: 'RPC account rate limit reached' });
    });
});
