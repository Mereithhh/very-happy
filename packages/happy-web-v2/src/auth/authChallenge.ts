import { getRandomBytes } from 'expo-crypto';
import sodium, { sodiumReady } from '@/encryption/libsodium.lib';

export async function authChallenge(secret: Uint8Array) {
    await sodiumReady();
    const keypair = sodium.crypto_sign_seed_keypair(secret);
    const challenge = getRandomBytes(32);
    const signature = sodium.crypto_sign_detached(challenge, keypair.privateKey);
    return { challenge, signature, publicKey: keypair.publicKey };
}