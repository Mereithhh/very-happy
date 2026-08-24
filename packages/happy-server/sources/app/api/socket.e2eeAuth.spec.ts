import { describe, expect, it } from 'vitest';
import { socketAuthAllowsConnection } from './socket';

describe('socket E2EE authorization boundary', () => {
    it('rejects a pending password unlock token before handlers are installed', () => {
        expect(socketAuthAllowsConnection({
            cryptoMode: 'e2ee-v1',
            deviceId: 'pending-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 1,
            capabilities: ['e2ee:unlock'],
        }, {
            cryptoMode: 'e2ee-v1',
            deviceId: 'pending-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 1,
        }, 'user-scoped')).toBe(false);
    });

    it('requires an active control token to match the socket device and protocol', () => {
        const extras = {
            cryptoMode: 'e2ee-v1' as const,
            deviceId: 'active-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 3,
            capabilities: ['e2ee:control'],
        };
        expect(socketAuthAllowsConnection(extras, {
            cryptoMode: 'e2ee-v1',
            deviceId: 'active-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 3,
        }, 'user-scoped')).toBe(true);
        expect(socketAuthAllowsConnection(extras, {
            cryptoMode: 'e2ee-v1',
            deviceId: 'different-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 3,
        }, 'user-scoped')).toBe(false);
        expect(socketAuthAllowsConnection(extras, {
            cryptoMode: 'e2ee-v1',
            deviceId: 'active-device',
            e2eeProtocol: 'vh-e2ee-0',
            cryptoEpoch: 3,
        }, 'user-scoped')).toBe(false);
        expect(socketAuthAllowsConnection(extras, {
            cryptoMode: 'e2ee-v1',
            deviceId: 'active-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 2,
        }, 'user-scoped')).toBe(false);
        expect(socketAuthAllowsConnection(extras, {
            cryptoMode: 'e2ee-v1',
            deviceId: 'active-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 3,
        }, 'machine-scoped')).toBe(false);
    });

    it('allows runner devices only on owned machine/session connection types', () => {
        const runner = {
            cryptoMode: 'e2ee-v1' as const,
            deviceId: 'runner-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 3,
            capabilities: ['e2ee:runner'],
        };
        const identity = {
            cryptoMode: 'e2ee-v1',
            deviceId: 'runner-device',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 3,
        };
        expect(socketAuthAllowsConnection(runner, identity, 'machine-scoped')).toBe(true);
        expect(socketAuthAllowsConnection(runner, identity, 'session-scoped')).toBe(true);
        expect(socketAuthAllowsConnection(runner, identity, 'user-scoped')).toBe(false);
    });

    it('preserves trusted-v1 socket compatibility', () => {
        expect(socketAuthAllowsConnection({ cryptoMode: 'trusted-v1' }, {}, 'machine-scoped')).toBe(true);
        expect(socketAuthAllowsConnection(undefined, {}, undefined)).toBe(true);
        expect(socketAuthAllowsConnection({ cryptoMode: 'trusted-v1' }, {
            cryptoMode: 'e2ee-v1', e2eeProtocol: 'vh-e2ee-1', deviceId: 'spoofed', cryptoEpoch: 1,
        }, 'user-scoped')).toBe(false);
    });
});
