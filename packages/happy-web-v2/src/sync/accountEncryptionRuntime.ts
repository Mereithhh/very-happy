import type { E2eeAuthCredentials } from '@/auth/tokenStorage';
import type { Encryption } from './encryption/encryption';

let activeEncryption: Encryption | null = null;

export function bindAccountEncryption(encryption: Encryption): void {
    activeEncryption = encryption;
}

export function clearAccountEncryption(encryption?: Encryption): void {
    if (!encryption || activeEncryption === encryption) activeEncryption = null;
}

export function requireE2eeAccountEncryption(credentials: E2eeAuthCredentials): Encryption {
    if (!activeEncryption || !activeEncryption.matchesE2eeAccount(credentials)) {
        throw new Error('E2EE account encryption is locked or belongs to another account');
    }
    return activeEncryption;
}
