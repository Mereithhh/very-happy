import { describe, expect, it } from 'vitest';
import {
    createRecoveryKeyringCapsule,
    openRecoveryKeyringCapsule,
    parseRecoveryKeyringCapsule,
    serializeRecoveryKeyringCapsule,
} from './e2eeRecoveryCapsule';

const bytes = (start: number, length = 32) => Uint8Array.from({ length }, (_, index) => start + index);

describe('E2EE recovery keyring capsule', () => {
    it('matches the frozen secretbox/signature vector and round-trips', async () => {
        const capsule = await createRecoveryKeyringCapsule({
            origin: 'https://happy.example',
            accountId: 'acc_vector_1',
            recoveryRootKey: bytes(0),
            recoveryAuthoritySeed: bytes(32),
            keyring: { currentEpoch: 1, epochs: [{ epoch: 1, secret: bytes(64) }] },
            nonce: bytes(96, 24),
        });
        expect(capsule.recoveryAuthorityPublicKey).toBe('Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc');
        expect(capsule.ciphertext).toBe(
            'sBVERt1vu-7R4Gqb4smmnOjsyre8OZVJhQUOQbsOeuMNQjdpLMCUfqMzdBxE2iFw7QnWXoxjyQAEWmYxOFc7xMO4lpx4kta7P95y8yxaE7ZcOP7_z5v_k6Xgt08W4RD7EJrN7V1jAxCiLgFYqVbSHHkS17OaIDDjoFJoEjGQP6OekNgEMkjywO88HqQuZzo9I4aQaLGXPqX7Nv3hHhBqOagMikn9AJkf8Cj8cq89p7OhZwdwRI0fEdlkwLDAB-dO9F4b3dZehk3xBcdxx8gzNMY8ZOL16P2yYAuUHlq0tjOpPM1E5K6izSuo7EELCJLTp7fxw-LcXckdd-dC2CdJR4CG-FFvwF9drZggpnFM4oROS-OkCMxRMaF_NuAKlsaihbs-PocFvSMe9bHaIaosP-XjQtbItpk',
        );
        expect(capsule.signature).toBe(
            'PfVy5oxBNGIZK_S2yGKWPoGKUAAcgsqU6pKHFPcNf7bkld1WMMiJLq_PsGX3AIEiY-1JI9f_VKEhPx8NZ5ywBw',
        );
        const serialized = serializeRecoveryKeyringCapsule(capsule);
        expect(parseRecoveryKeyringCapsule(serialized)).toEqual(capsule);
        const opened = await openRecoveryKeyringCapsule({
            capsule,
            recoveryRootKey: bytes(0),
            expectedOrigin: 'https://happy.example',
            expectedAccountId: 'acc_vector_1',
            expectedRecoveryAuthorityPublicKey: capsule.recoveryAuthorityPublicKey,
        });
        expect(opened.recoveryAuthoritySeed).toEqual(bytes(32));
        expect(opened.keyring.epochs[0].secret).toEqual(bytes(64));
    });

    it('fails closed for wrong RRK, tampering, context mismatch, and rollback', async () => {
        const capsule = await createRecoveryKeyringCapsule({
            origin: 'https://happy.example', accountId: 'acc_vector_1',
            recoveryRootKey: bytes(0), recoveryAuthoritySeed: bytes(32),
            keyring: { currentEpoch: 1, epochs: [{ epoch: 1, secret: bytes(64) }] },
            nonce: bytes(96, 24),
        });
        const base = {
            capsule, recoveryRootKey: bytes(0), expectedOrigin: 'https://happy.example',
            expectedAccountId: 'acc_vector_1',
        };
        await expect(openRecoveryKeyringCapsule({ ...base, recoveryRootKey: bytes(1) }))
            .rejects.toThrow(/authentication/);
        await expect(openRecoveryKeyringCapsule({ ...base, expectedAccountId: 'acc_other' }))
            .rejects.toThrow(/context/);
        await expect(openRecoveryKeyringCapsule({ ...base, highestKnownEpoch: 2 }))
            .rejects.toThrow(/rollback/);
        await expect(openRecoveryKeyringCapsule({
            ...base,
            capsule: { ...capsule, ciphertext: `A${capsule.ciphertext.slice(1)}` },
        })).rejects.toThrow();
        expect(() => parseRecoveryKeyringCapsule(`${serializeRecoveryKeyringCapsule(capsule)} `))
            .toThrow(/Non-canonical/);
    });
});

