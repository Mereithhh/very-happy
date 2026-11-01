import sodium from 'libsodium-wrappers';
import { readyWithin } from './readyDeadline';

// B-859: libsodium-wrappers attaches every crypto_* function only once its
// wasm has instantiated; until then `sodium.crypto_box_seed_keypair` is
// undefined. Every caller that touches sodium on a first-run path awaits this
// first: Encryption.create (bootstrap restore and every login), authChallenge
// (token challenge) and generateAuthKeyPair (QR pairing).
//
// B-859b: if the wasm never comes up, reject instead of hanging on the splash,
// so a restore surfaces as SyncNotStartedError → retry → /login. The wasm is
// inlined in this chunk, so the clock starts after the download and slow
// networks do not eat into it. Measured in headless Chromium: compile ≤ 70 ms
// and ready ≤ 3.8 s after navigation even at 20x CPU throttle; 12 s leaves
// ≥ 3x headroom while "never ready" reaches /login in ~16 s, not forever.
export const SODIUM_READY_TIMEOUT_MS = 12_000;

export const sodiumReady: () => Promise<void> = readyWithin(sodium.ready, SODIUM_READY_TIMEOUT_MS, 'libsodium');

export default sodium;
