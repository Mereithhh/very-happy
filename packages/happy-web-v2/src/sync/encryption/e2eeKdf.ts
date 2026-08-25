import { E2EE_DOMAIN_PREFIX, utf8 } from './e2eeEncoding';

const KEY_BYTES = 32;
let suiteSaltPromise: Promise<ArrayBuffer> | null = null;

async function suiteSalt(): Promise<ArrayBuffer> {
    suiteSaltPromise ??= crypto.subtle.digest('SHA-256', utf8(E2EE_DOMAIN_PREFIX) as BufferSource);
    return suiteSaltPromise;
}

export async function deriveE2eeKey(
    inputKeyMaterial: Uint8Array,
    asciiDomainLabel: string,
    length = KEY_BYTES,
): Promise<Uint8Array> {
    if (inputKeyMaterial.length !== KEY_BYTES) throw new Error('E2EE key material must be 32 bytes');
    if (!/^[\x20-\x7e]+$/.test(asciiDomainLabel)
        || !asciiDomainLabel.startsWith(`${E2EE_DOMAIN_PREFIX}/`)) {
        throw new Error('Invalid E2EE HKDF domain label');
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > 8_160) {
        throw new Error('Invalid HKDF output length');
    }
    const key = await crypto.subtle.importKey(
        'raw', inputKeyMaterial as BufferSource, 'HKDF', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: await suiteSalt(),
        info: utf8(asciiDomainLabel) as BufferSource,
    }, key, length * 8);
    return new Uint8Array(bits);
}

