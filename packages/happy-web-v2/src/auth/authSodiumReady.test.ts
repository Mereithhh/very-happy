import { describe, expect, it, vi } from 'vitest';

// B-859b: same window as encryption.sodiumReady.test.ts — crypto_* are absent
// until `sodiumReady()` resolves. The auth paths must wait, not throw.
const gate = vi.hoisted(() => {
    let open!: () => void;
    const ready = new Promise<void>((resolve) => { open = resolve; });
    return { ready, open, sodium: {} as Record<string, unknown> };
});

vi.mock('@/encryption/libsodium.lib', async () => {
    const real = (await import('libsodium-wrappers')).default;
    await real.ready;
    void gate.ready.then(() => Object.assign(gate.sodium, real));
    return { default: gate.sodium, sodiumReady: () => gate.ready };
});

// authQRStart pulls in the socket/server config only for its HTTP half.
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'test' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://localhost' }));

describe('auth paths before libsodium is ready (B-859b)', () => {
    it('authChallenge and generateAuthKeyPair wait for sodiumReady instead of throwing', async () => {
        const { authChallenge } = await import('./authChallenge');
        const { generateAuthKeyPair } = await import('./authQRStart');
        expect(gate.sodium.crypto_sign_seed_keypair).toBeUndefined();

        const outcomes: string[] = [];
        const challenge = authChallenge(new Uint8Array(32).fill(3));
        const pair = generateAuthKeyPair();
        challenge.then(() => outcomes.push('challenge'), (e) => outcomes.push(`challenge rejected: ${e}`));
        pair.then(() => outcomes.push('pair'), (e) => outcomes.push(`pair rejected: ${e}`));

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(outcomes).toEqual([]);

        gate.open();
        const c = await challenge;
        const p = await pair;
        const real = (await import('libsodium-wrappers')).default;
        expect(real.crypto_sign_verify_detached(c.signature, c.challenge, c.publicKey)).toBe(true);
        expect(p.publicKey).toHaveLength(32);
        expect(p.secretKey).toHaveLength(32);
    });
});
