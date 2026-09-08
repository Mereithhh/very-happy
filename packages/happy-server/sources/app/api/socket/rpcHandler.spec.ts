import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rpcHandler, rpcMetricMethod } from './rpcHandler';
import { AccountTerminalRateLimiter, relayPayloadBytes } from './terminalRateLimit';
import { log } from '@/utils/log';
import { sanitizeLogValue, stableLogRef } from '@/utils/logSafety';

vi.mock('@/utils/log', () => ({ log: vi.fn() }));

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
        vi.mocked(log).mockClear();
        delete process.env.RPC_MAX_PAYLOAD_BYTES;
        delete process.env.RPC_MAX_CALLS_PER_MINUTE;
        delete process.env.RPC_MAX_REGISTERED_METHODS_PER_SOCKET;
    });

    it('logs failed RPCs with sanitized correlation and finite method/result categories', async () => {
        process.env.RPC_MAX_PAYLOAD_BYTES = '64';
        const { socket, handlers } = fakeSocket('private-socket');
        rpcHandler('private-user', socket, {} as any);
        const callback = vi.fn();
        await handlers.get('rpc-call')!({ method: 'private-machine:open-terminal', params: 'secret-command'.repeat(10) }, callback);
        const metadata = vi.mocked(log).mock.calls.find(([entry]: any[]) => entry.event === 'rpc-failed')![0];
        const safe = sanitizeLogValue(metadata);
        expect(safe).toEqual({
            module: 'websocket', event: 'rpc-failed', userId: stableLogRef('userId', 'private-user'),
            socketId: stableLogRef('socketId', 'private-socket'),
            roomId: stableLogRef('roomId', 'rpc:private-user:private-machine:open-terminal'),
            method: 'open-terminal', code: 'payload_limit', durationMs: expect.any(Number),
        });
        for (const value of ['private-user', 'private-machine', 'private-socket', 'secret-command']) {
            expect(JSON.stringify(safe)).not.toContain(value);
        }
        vi.mocked(log).mockClear();
        await handlers.get('rpc-call')!({ method: 'private-machine:secret-command', params: 'x'.repeat(100) }, callback);
        expect(sanitizeLogValue(vi.mocked(log).mock.calls[0][0])).toMatchObject({ method: 'other', code: 'payload_limit' });
    });

    it('does not log successful RPC calls', async () => {
        const { socket, handlers } = fakeSocket();
        const target = { id: 'daemon-socket', timeout: () => ({ emitWithAck: async () => 'private-response' }) };
        const io = { in: () => ({ timeout: () => ({ fetchSockets: async () => [target] }) }) };
        rpcHandler('account-1', socket, io as any);
        const callback = vi.fn();
        await handlers.get('rpc-call')!({ method: 'machine:open-terminal', params: 'private-command' }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: true, result: 'private-response' });
        expect(log).not.toHaveBeenCalled();
    });

    it('rejects registration from user sockets', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any);
        handlers.get('rpc-register')!({ method: 'machine:spawn' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'Authenticated RPC scope required',
        });
    });

    it('allows registration within an authenticated machine or session scope', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'machine-1');
        handlers.get('rpc-register')!({ method: 'machine-1:spawn' });
        expect(socket.join).toHaveBeenCalledWith('rpc:account-1:machine-1:spawn');

        const session = fakeSocket('session-socket');
        rpcHandler('account-1', session.socket, {} as any, 'session-1');
        session.handlers.get('rpc-register')!({ method: 'session-1:killSession' });
        expect(session.socket.join).toHaveBeenCalledWith('rpc:account-1:session-1:killSession');
    });

    it('rejects a machine daemon registering another machine scope', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'machine-1');
        handlers.get('rpc-register')!({ method: 'machine-2:spawn' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'Method is outside authenticated connection scope',
        });
    });

    it('rejects a session client registering another session scope', () => {
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any, 'session-1');
        handlers.get('rpc-register')!({ method: 'session-2:killSession' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register', error: 'Method is outside authenticated connection scope',
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

    it('meters per-socket calls as a token bucket: burst, then refill at the per-minute rate, with retryAfterMs (T-014)', async () => {
        // The limiter reads Date.now(); a spy avoids fake timers (the rpc-call
        // handler awaits real setTimeout-based helpers on other paths).
        const now = vi.spyOn(Date, 'now');
        try {
            now.mockReturnValue(100_000);
            process.env.RPC_MAX_CALLS_PER_MINUTE = '60'; // 1 token/second, burst 60
            const { socket, handlers } = fakeSocket();
            rpcHandler('account-1', socket, {} as any);
            // `method: 123` passes the limiter first, then fails validation
            // synchronously without touching io — a cheap way to count tokens.
            const call = async () => {
                const callback = vi.fn();
                await handlers.get('rpc-call')!({ method: 123, params: {} }, callback);
                return callback.mock.calls[0][0];
            };
            for (let i = 0; i < 60; i++) {
                expect((await call()).error).toBe('Invalid parameters: method is required');
            }
            const refused = await call();
            expect(refused).toEqual({
                ok: false,
                error: 'RPC rate limit reached',
                code: 'rpc_rate_limited',
                retryAfterMs: 1_000,
            });
            // A refusal is not charged: the hint is honest, one token later a call passes.
            now.mockReturnValue(101_000);
            expect((await call()).error).toBe('Invalid parameters: method is required');
            // No fixed-window cliff: 30s later exactly 30 tokens have refilled, not 0 and not 60.
            now.mockReturnValue(131_000);
            for (let i = 0; i < 30; i++) {
                expect((await call()).error).toBe('Invalid parameters: method is required');
            }
            expect((await call()).code).toBe('rpc_rate_limited');
        } finally {
            now.mockRestore();
        }
    });

    it('disables per-socket metering when RPC_MAX_CALLS_PER_MINUTE is 0', async () => {
        process.env.RPC_MAX_CALLS_PER_MINUTE = '0';
        const { socket, handlers } = fakeSocket();
        rpcHandler('account-1', socket, {} as any);
        for (let i = 0; i < 500; i++) {
            const callback = vi.fn();
            await handlers.get('rpc-call')!({ method: 123, params: {} }, callback);
            expect(callback.mock.calls[0][0].error).toBe('Invalid parameters: method is required');
        }
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
        expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            error: 'RPC account rate limit reached',
            code: 'rpc_account_rate_limited',
        }));
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
        expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            error: 'RPC account rate limit reached',
            code: 'rpc_account_rate_limited',
        }));
    });
});
