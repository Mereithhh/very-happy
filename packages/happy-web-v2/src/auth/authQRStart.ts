import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import axios from 'axios';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    claimSecret: string;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
        claimSecret: encodeBase64(getRandomBytes(32)),
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${serverUrl}/v1/auth/account/request`);
        }

        const response = await axios.post(`${serverUrl}/v1/auth/account/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            supportsClaimSecret: true,
            claimSecret: keypair.claimSecret,
            pairingAction: 'create',
        }, {
            headers: {
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (response.data?.protocolVersion !== 3 || response.data?.claimSecretRequired !== true) {
            console.log('Server upgrade required for secure account pairing.');
            return false;
        }

        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Auth request sent successfully');
        }
        return true;
    } catch {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Failed to send secure auth request');
        }
        console.log('Failed to create a secure authentication request. Please try again later.');
        return false;
    }
}
