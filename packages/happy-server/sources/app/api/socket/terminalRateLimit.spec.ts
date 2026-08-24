import { describe, expect, it } from 'vitest';
import { AccountTerminalRateLimiter, relayPayloadBytes, resolveRpcRelayLimit, resolveTerminalRelayLimit } from './terminalRateLimit';

describe('resolveTerminalRelayLimit', () => {
    it('has a bounded public-server default', () => {
        expect(resolveTerminalRelayLimit({})).toEqual({
            bytesPerSecond: 2 * 1024 * 1024,
            burstBytes: 8 * 1024 * 1024,
            eventsPerSecond: 200,
            burstEvents: 400,
        });
    });

    it('accepts explicit limits and zero disables each dimension', () => {
        expect(resolveTerminalRelayLimit({
            TERMINAL_RELAY_BYTES_PER_SECOND: '0',
            TERMINAL_RELAY_BURST_BYTES: '0',
            TERMINAL_RELAY_EVENTS_PER_SECOND: '10',
            TERMINAL_RELAY_BURST_EVENTS: '20',
        })).toEqual({ bytesPerSecond: 0, burstBytes: 0, eventsPerSecond: 10, burstEvents: 20 });
    });
});

describe('resolveRpcRelayLimit', () => {
    it('allows one complete 8 MiB chunked handoff inside a bounded account burst', () => {
        const limit = resolveRpcRelayLimit({});
        expect(limit).toEqual({
            bytesPerSecond: 2 * 1024 * 1024,
            burstBytes: 20 * 1024 * 1024,
            eventsPerSecond: 2,
            burstEvents: 120,
        });
        const limiter = new AccountTerminalRateLimiter(limit);
        const representativeChunk = {
            method: 'machine-1:uploadFileChunk',
            params: 'x'.repeat(176 * 1024),
        };
        const calls = [
            { method: representativeChunk.method, params: 'x'.repeat(512) },
            ...Array.from({ length: 86 }, () => representativeChunk),
            { method: representativeChunk.method, params: 'x'.repeat(256) },
        ];
        const charged = calls.reduce((sum, call) => sum + relayPayloadBytes(call), 0);
        expect(calls).toHaveLength(88);
        expect(relayPayloadBytes(representativeChunk)).toBeLessThan(256 * 1024);
        expect(charged).toBeLessThan(limit.burstBytes);
        expect(calls.every((call) => limiter.consume('account-a', relayPayloadBytes(call), 1_000))).toBe(true);
    });

    it('accepts explicit RPC relay limits and zero disables each dimension', () => {
        expect(resolveRpcRelayLimit({
            RPC_RELAY_BYTES_PER_SECOND: '0',
            RPC_RELAY_BURST_BYTES: '0',
            RPC_RELAY_EVENTS_PER_SECOND: '10',
            RPC_RELAY_BURST_EVENTS: '20',
        })).toEqual({ bytesPerSecond: 0, burstBytes: 0, eventsPerSecond: 10, burstEvents: 20 });
    });
});

describe('AccountTerminalRateLimiter', () => {
    it('shares the allowance across sockets from the same account', () => {
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 100,
            burstBytes: 100,
            eventsPerSecond: 2,
            burstEvents: 2,
        });
        expect(limiter.consume('account-a', 60, 1_000)).toBe(true);
        expect(limiter.consume('account-a', 40, 1_000)).toBe(true);
        expect(limiter.consume('account-a', 1, 1_000)).toBe(false);
        expect(limiter.consume('account-b', 100, 1_000)).toBe(true);
    });

    it('refills over time without exceeding the burst', () => {
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 100,
            burstBytes: 100,
            eventsPerSecond: 10,
            burstEvents: 10,
        });
        expect(limiter.consume('a', 100, 1_000)).toBe(true);
        expect(limiter.consume('a', 1, 1_000)).toBe(false);
        expect(limiter.consume('a', 50, 1_500)).toBe(true);
        expect(limiter.consume('a', 51, 1_500)).toBe(false);
    });

    it('can disable both dimensions explicitly', () => {
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 0,
            burstBytes: 0,
            eventsPerSecond: 0,
            burstEvents: 0,
        });
        expect(limiter.consume('a', Number.MAX_SAFE_INTEGER, 0)).toBe(true);
    });
});

describe('relayPayloadBytes', () => {
    it('charges identifiers and unknown fields instead of only the forwarded data field', () => {
        const payload = { terminalId: 'x'.repeat(1024), data: '', ignored: 'y'.repeat(1024) };
        expect(relayPayloadBytes(payload)).toBeGreaterThan(2048);
    });

    it('fails closed for a payload that cannot be serialized', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(relayPayloadBytes(circular)).toBe(Number.MAX_SAFE_INTEGER);
    });
});
