import { describe, expect, it } from 'vitest';
import {
    createControlDeviceRootEnvelope,
    deriveControlDeviceKeyPairs,
    generateControlDeviceKeyPairs,
    openControlDeviceRootEnvelope,
} from './e2eeDeviceEnvelope';
import { deriveRecoveryAuthorityKeyPair } from './e2eeKeyHierarchy';
import { encodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';

const bytes = (start: number, length = 32) => Uint8Array.from(
    { length },
    (_, index) => (start + index) & 0xff,
);

describe('E2EE control device root envelope', () => {
    it('derives independent control-device keypairs and matches the frozen box/signature vector', async () => {
        const device = await deriveControlDeviceKeyPairs({
            encryptionSeed: bytes(0),
            signingSeed: bytes(32),
        });
        const authority = await deriveRecoveryAuthorityKeyPair(bytes(64));
        expect(encodeBase64UrlCanonical(device.encryptionPublicKey))
            .toBe('RwHQhIhFH1RaQJ-1iuPlhYHKQKw_fxFGmM1x3qxzygE');
        expect(encodeBase64UrlCanonical(device.signingPublicKey))
            .toBe('Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc');
        const envelope = await createControlDeviceRootEnvelope({
            origin: 'https://happy.example',
            accountId: 'acc_vector_1',
            deviceId: 'dev_vector_1',
            recipientEncryptionPublicKey: device.encryptionPublicKey,
            keyring: { currentEpoch: 1, epochs: [{ epoch: 1, secret: bytes(96) }] },
            authorizer: { kind: 'recovery', recoveryAuthoritySeed: bytes(64) },
            ephemeralSeed: bytes(128),
            nonce: bytes(160, 24),
        });
        expect(envelope.ephemeralPublicKey)
            .toBe('PecMsrm7C9o4c9E-inz06ocNq-spbKod_OCl9BHI0jQ');
        expect(envelope.ciphertext).toBe(
            '1WACX9PWCUzlagOKVa1ZBbfAlj8N-RlOvzvsVf_ENoPP8sr481pchYLiip2o-xBUWhhQHECjD0GHDu_dFw6SX5nBF571NSoC6lnJn8DeBC2Bj3Hfc8qPgbKyyXUbZegiaK7S18BdFelRkvy92zpGe7Eq3zapuwUGMDqRDsEpTE3QE4BVDreDzo_eWwdXEIsucPKpEy_RUTildiDDVvn1OId1GRHOKwKcg3S4rHHTSM8fcSpy1qIaG7bxwKqhK1fPg4fOMUsg6ruJGrM2VCSEHaKD8dbHlpUQvA1dts8JC_JEoCyatD2Ek0LsIY1Dyp5Ws_CJBn4ZfjtXvJ66cba39PeFVqjJzea_QiM0dJYcHcHfOp5HYDGW',
        );
        expect(envelope.signature).toBe(
            'pKbrXkp3uv-NXdYl3qaD2nAf3MpiWrrYcOLh5LecLED0QTQ8asMWAtUEJsMuFKcvufFOFEE9g-2sSsLDaa_rCg',
        );
        await expect(openControlDeviceRootEnvelope({
            envelope,
            recipientEncryptionPrivateKey: device.encryptionPrivateKey,
            authorizerSigningPublicKey: authority.publicKey,
            expectedOrigin: 'https://happy.example',
            expectedAccountId: 'acc_vector_1',
            expectedDeviceId: 'dev_vector_1',
            expectedAuthorizer: { kind: 'recovery' },
        })).resolves.toEqual({ currentEpoch: 1, epochs: [{ epoch: 1, secret: bytes(96) }] });
    });

    it('fails closed for wrong recipient, signer, context, tampering, and rollback', async () => {
        let draw = 0;
        const generated = await generateControlDeviceKeyPairs((length) => new Uint8Array(length).fill(++draw));
        expect(draw).toBe(2);
        const authority = await deriveRecoveryAuthorityKeyPair(bytes(64));
        const envelope = await createControlDeviceRootEnvelope({
            origin: 'https://happy.example', accountId: 'acc_vector_1', deviceId: 'dev_vector_1',
            recipientEncryptionPublicKey: generated.encryptionPublicKey,
            keyring: { currentEpoch: 1, epochs: [{ epoch: 1, secret: bytes(96) }] },
            authorizer: { kind: 'recovery', recoveryAuthoritySeed: bytes(64) },
            ephemeralSeed: bytes(128), nonce: bytes(160, 24),
        });
        const base = {
            envelope,
            recipientEncryptionPrivateKey: generated.encryptionPrivateKey,
            authorizerSigningPublicKey: authority.publicKey,
            expectedOrigin: 'https://happy.example', expectedAccountId: 'acc_vector_1',
            expectedDeviceId: 'dev_vector_1', expectedAuthorizer: { kind: 'recovery' } as const,
        };
        await expect(openControlDeviceRootEnvelope({ ...base, highestKnownEpoch: 2 }))
            .rejects.toThrow(/rollback/);
        await expect(openControlDeviceRootEnvelope({ ...base, expectedDeviceId: 'dev_other' }))
            .rejects.toThrow(/context/);
        await expect(openControlDeviceRootEnvelope({
            ...base,
            expectedAuthorizer: { kind: 'device', deviceId: 'dev_other' },
        })).rejects.toThrow(/authorizer/);
        const { expectedAuthorizer: _omittedAuthorizer, ...withoutExpectedAuthorizer } = base;
        await expect(openControlDeviceRootEnvelope(withoutExpectedAuthorizer as never))
            .rejects.toThrow(/authorizer/);
        await expect(openControlDeviceRootEnvelope({
            ...base, authorizerSigningPublicKey: new Uint8Array(32),
        })).rejects.toThrow(/signature/);
        await expect(openControlDeviceRootEnvelope({
            ...base, recipientEncryptionPrivateKey: new Uint8Array(32),
        })).rejects.toThrow(/authentication/);
        await expect(openControlDeviceRootEnvelope({
            ...base,
            envelope: {
                ...envelope,
                ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`,
            },
        })).rejects.toThrow(/signature/);
    });
});
