import { describe, expect, it, vi } from 'vitest';

// B-859: libsodium-wrappers only attaches crypto_* once its wasm instantiates.
// Model that window deterministically: the mocked module exposes an empty
// object whose functions appear when `gate.open()` resolves `sodiumReady`.
const gate = vi.hoisted(() => {
    let open!: () => void;
    const ready = new Promise<void>((resolve) => { open = resolve; });
    return { ready, open, sodium: {} as Record<string, unknown> };
});

vi.mock('@/encryption/libsodium.lib', async () => {
    const real = (await import('libsodium-wrappers')).default;
    await real.ready;
    // Registered before any importer awaits `sodiumReady`, so it runs first.
    void gate.ready.then(() => Object.assign(gate.sodium, real));
    return { default: gate.sodium, sodiumReady: gate.ready };
});

describe('Encryption.create before libsodium is ready (B-859)', () => {
    it('waits for sodiumReady instead of calling an undefined crypto_box_seed_keypair', async () => {
        const { Encryption } = await import('./encryption');
        expect(gate.sodium.crypto_box_seed_keypair).toBeUndefined();

        let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
        const created = Encryption.create(new Uint8Array(32).fill(7));
        created.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

        // Long enough for every WebCrypto derive step to finish: before the fix
        // create() had already rejected with "is not a function" by now.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(outcome).toBe('pending');

        gate.open();
        const encryption = await created;
        expect(outcome).toBe('resolved');

        const real = (await import('libsodium-wrappers')).default;
        const { deriveKey } = await import('@/encryption/deriveKey');
        const contentDataKey = await deriveKey(new Uint8Array(32).fill(7), 'Happy EnCoder', ['content']);
        expect(Array.from(encryption.contentDataKey)).toEqual(Array.from(real.crypto_box_seed_keypair(contentDataKey).publicKey));
    });
});
