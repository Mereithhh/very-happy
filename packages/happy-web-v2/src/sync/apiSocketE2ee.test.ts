import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.3' } } }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ localSettings: {} }) } }));

describe('user-scoped socket E2EE identity', () => {
    it('adds only public device binding fields', async () => {
        const { buildUserScopedSocketAuth } = await import('./apiSocket');
        const auth = buildUserScopedSocketAuth({
            endpoint: 'https://happy.example',
            token: 'token',
            e2eeIdentity: {
                cryptoMode: 'e2ee-v1',
                e2eeProtocol: 'vh-e2ee-1',
                deviceId: 'device_1',
                cryptoEpoch: 3,
            },
        });
        expect(auth).toMatchObject({
            token: 'token',
            clientType: 'user-scoped',
            cryptoMode: 'e2ee-v1',
            e2eeProtocol: 'vh-e2ee-1',
            deviceId: 'device_1',
            cryptoEpoch: 3,
        });
        expect(auth).not.toHaveProperty('secret');
        expect(auth).not.toHaveProperty('privateKey');
    });

    it('rejects malformed E2EE identities before opening a socket', async () => {
        const { buildUserScopedSocketAuth } = await import('./apiSocket');
        expect(() => buildUserScopedSocketAuth({
            endpoint: 'https://happy.example',
            token: 'token',
            e2eeIdentity: {
                cryptoMode: 'e2ee-v1',
                e2eeProtocol: 'vh-e2ee-1',
                deviceId: '',
                cryptoEpoch: 1,
            },
        })).toThrow();
    });
});
