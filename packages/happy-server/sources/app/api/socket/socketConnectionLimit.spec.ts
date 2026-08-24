import { describe, expect, it } from 'vitest';
import { resolveSocketConnectionLimit } from './socketConnectionLimit';

describe('resolveSocketConnectionLimit', () => {
    it('leaves room for established accounts with many long-lived sessions', () => {
        expect(resolveSocketConnectionLimit({})).toBe(128);
    });

    it('accepts an operator override including zero to disable the cap', () => {
        expect(resolveSocketConnectionLimit({ SOCKET_MAX_CONNECTIONS_PER_ACCOUNT: '64' })).toBe(64);
        expect(resolveSocketConnectionLimit({ SOCKET_MAX_CONNECTIONS_PER_ACCOUNT: '0' })).toBe(0);
    });

    it('falls back safely for empty, negative, or invalid values', () => {
        expect(resolveSocketConnectionLimit({ SOCKET_MAX_CONNECTIONS_PER_ACCOUNT: '' })).toBe(128);
        expect(resolveSocketConnectionLimit({ SOCKET_MAX_CONNECTIONS_PER_ACCOUNT: '-1' })).toBe(128);
        expect(resolveSocketConnectionLimit({ SOCKET_MAX_CONNECTIONS_PER_ACCOUNT: 'invalid' })).toBe(128);
    });
});
