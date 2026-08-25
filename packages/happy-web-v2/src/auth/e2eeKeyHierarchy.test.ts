import { describe, expect, it } from 'vitest';
import {
    deriveEpochContentKeyPair,
    deriveRecoveryAuthorityKeyPair,
    generateInitialE2eeKeyHierarchy,
    signEpochContentKey,
    verifyEpochContentKey,
    verifyEpochSecretMatchesContentKey,
} from './e2eeKeyHierarchy';
import { encodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';

const bytes = (start: number) => Uint8Array.from({ length: 32 }, (_, index) => start + index);

describe('vh-e2ee-1 key hierarchy', () => {
    it('draws RRK, I, and E1 independently', () => {
        let draw = 0;
        const hierarchy = generateInitialE2eeKeyHierarchy((length) => {
            expect(length).toBe(32);
            return new Uint8Array(length).fill(++draw);
        });
        expect(draw).toBe(3);
        expect(hierarchy.recoveryRootKey).toEqual(new Uint8Array(32).fill(1));
        expect(hierarchy.recoveryAuthoritySeed).toEqual(new Uint8Array(32).fill(2));
        expect(hierarchy.keyring.epochs[0].secret).toEqual(new Uint8Array(32).fill(3));
        expect(hierarchy.recoveryRootKey).not.toBe(hierarchy.recoveryAuthoritySeed);
    });

    it('matches the frozen authority/content/signature vector', async () => {
        const authority = await deriveRecoveryAuthorityKeyPair(bytes(32));
        const content = await deriveEpochContentKeyPair(bytes(64), 1);
        expect(encodeBase64UrlCanonical(authority.publicKey))
            .toBe('Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc');
        expect(encodeBase64UrlCanonical(content.publicKey))
            .toBe('7VaiGgcXYa3ikX8geVWiPKNoPgLzKvTzDIceC6icpGg');

        const signature = await signEpochContentKey({
            origin: 'https://happy.example',
            accountId: 'acc_vector_1',
            epoch: 1,
            contentPublicKey: content.publicKey,
            recoveryAuthoritySeed: bytes(32),
        });
        expect(signature).toBe(
            'HliXCJDYlmRVL3lw7ySiVhj_CcKlH4Y3ajtM-nd1pygUzVMyNwPSQuG73eTM0zHplLr9O2LNcYhhUw8zwAmbBA',
        );
        await expect(verifyEpochContentKey({
            origin: 'https://happy.example',
            accountId: 'acc_vector_1',
            epoch: 1,
            contentPublicKey: content.publicKey,
            recoveryAuthorityPublicKey: authority.publicKey,
            signature,
        })).resolves.toBe(true);
        await expect(verifyEpochSecretMatchesContentKey({
            epochSecret: bytes(64), epoch: 1, expectedContentPublicKey: content.publicKey,
        })).resolves.toBe(true);
    });
});

