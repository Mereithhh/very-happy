import { describe, expect, it, vi } from 'vitest';
import type { E2eeAuthCredentials } from './tokenStorage';
import { E2eeUnlockError } from './e2eeRuntime';
import { establishE2eeLogin } from './e2eeLoginLifecycle';

const credentials = {
    version: 2,
    token: 'bearer',
    origin: 'https://happy.example',
    accountId: 'account_1',
    deviceId: 'device_1',
    cryptoMode: 'e2ee-v1',
    e2eeProtocol: 'vh-e2ee-1',
    cryptoEpoch: 1,
    recoveryAuthorityPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    contentPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    contentKeySignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} satisfies E2eeAuthCredentials;

function dependencies(createSync: () => Promise<void>) {
    return {
        createSync,
        persistCredentials: vi.fn(async () => true),
        lockSync: vi.fn(),
    };
}

describe('E2EE login lifecycle', () => {
    it('validates the vault and signed key context before persisting the bearer', async () => {
        const order: string[] = [];
        const deps = dependencies(async () => { order.push('validate'); });
        deps.persistCredentials.mockImplementation(async () => {
            order.push('persist');
            return true;
        });

        await expect(establishE2eeLogin(credentials, deps)).resolves.toBe('unlocked');
        expect(order).toEqual(['validate', 'persist']);
        expect(deps.lockSync).not.toHaveBeenCalled();
    });

    it('persists only a missing-key bearer for the explicit recovery flow', async () => {
        const deps = dependencies(async () => {
            throw new E2eeUnlockError('missing-local-keys', 'locked');
        });

        await expect(establishE2eeLogin(credentials, deps)).resolves.toBe('locked-needs-recovery');
        expect(deps.lockSync).toHaveBeenCalledOnce();
        expect(deps.persistCredentials).toHaveBeenCalledWith(credentials);
    });

    it.each(['vault-auth-failed', 'key-context-mismatch'] as const)(
        'never persists a bearer after %s',
        async (code) => {
            const deps = dependencies(async () => {
                throw new E2eeUnlockError(code, 'invalid');
            });

            await expect(establishE2eeLogin(credentials, deps)).rejects.toMatchObject({ code });
            expect(deps.lockSync).toHaveBeenCalledOnce();
            expect(deps.persistCredentials).not.toHaveBeenCalled();
        },
    );

    it('locks an initialized runtime if bearer persistence fails', async () => {
        const deps = dependencies(async () => undefined);
        deps.persistCredentials.mockResolvedValue(false);

        await expect(establishE2eeLogin(credentials, deps)).rejects.toThrow(/save E2EE credentials/);
        expect(deps.lockSync).toHaveBeenCalledOnce();
    });
});
