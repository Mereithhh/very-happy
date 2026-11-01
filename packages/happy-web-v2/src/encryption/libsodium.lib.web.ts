import sodium from 'libsodium-wrappers';

// B-859: libsodium-wrappers attaches every crypto_* function only once its
// wasm has instantiated; until then `sodium.crypto_box_seed_keypair` is
// undefined. Nothing else orders the first call after that, so every entry
// path (bootstrap restore, login, token challenge) awaits this first.
export const sodiumReady: Promise<void> = sodium.ready;

export default sodium;
