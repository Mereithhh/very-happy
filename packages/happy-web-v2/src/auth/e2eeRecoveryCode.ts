import { constantTimeEqual, utf8 } from '@/sync/encryption/e2eeEncoding';

const RECOVERY_CODE_PREFIX = 'VH1';
const RECOVERY_KEY_BYTES = 32;
const CHECKSUM_BYTES = 4;
// Exactly 32 symbols.  0/O and 1/I do not exist.  9 and G remain distinct and
// are never silently substituted for one another.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHAR_TO_VALUE = new Map([...ALPHABET].map((char, index) => [char, index]));
const PAYLOAD_SYMBOLS = Math.ceil(((RECOVERY_KEY_BYTES + CHECKSUM_BYTES) * 8) / 5);
const CHECKSUM_DOMAIN = utf8('very-happy/vh-e2ee-1/recovery-code/checksum');

async function checksum(key: Uint8Array): Promise<Uint8Array> {
    const input = new Uint8Array(CHECKSUM_DOMAIN.length + key.length);
    input.set(CHECKSUM_DOMAIN);
    input.set(key, CHECKSUM_DOMAIN.length);
    const digest = await crypto.subtle.digest('SHA-256', input as BufferSource);
    input.fill(0);
    return new Uint8Array(digest).slice(0, CHECKSUM_BYTES);
}

function encodeBase32(bytes: Uint8Array): string {
    let accumulator = 0;
    let bits = 0;
    let output = '';
    for (const byte of bytes) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            output += ALPHABET[(accumulator >>> bits) & 31];
            accumulator &= (1 << bits) - 1;
        }
    }
    if (bits > 0) output += ALPHABET[(accumulator << (5 - bits)) & 31];
    return output;
}

function decodeBase32(value: string): Uint8Array {
    let accumulator = 0;
    let bits = 0;
    const output: number[] = [];
    for (const char of value) {
        const decoded = CHAR_TO_VALUE.get(char);
        if (decoded === undefined) throw new Error('Recovery code contains an invalid character');
        accumulator = (accumulator << 5) | decoded;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            output.push((accumulator >>> bits) & 0xff);
            accumulator &= (1 << bits) - 1;
        }
    }
    if (bits > 0 && accumulator !== 0) throw new Error('Recovery code is not canonical');
    return new Uint8Array(output);
}

function formatPayload(payload: string): string {
    const groups = payload.match(/.{1,4}/g);
    if (!groups) throw new Error('Recovery code payload is empty');
    return `${RECOVERY_CODE_PREFIX}-${groups.join('-')}`;
}

export async function encodeE2eeRecoveryCode(recoveryRootKey: Uint8Array): Promise<string> {
    if (recoveryRootKey.length !== RECOVERY_KEY_BYTES) {
        throw new Error('Recovery Root Key must be 32 bytes');
    }
    const check = await checksum(recoveryRootKey);
    const payload = new Uint8Array(RECOVERY_KEY_BYTES + CHECKSUM_BYTES);
    payload.set(recoveryRootKey);
    payload.set(check, RECOVERY_KEY_BYTES);
    const code = formatPayload(encodeBase32(payload));
    payload.fill(0);
    check.fill(0);
    return code;
}

export async function decodeE2eeRecoveryCode(code: string): Promise<Uint8Array> {
    if (typeof code !== 'string' || code.length > 128) throw new Error('Invalid recovery code');
    const expectedPattern = new RegExp(`^${RECOVERY_CODE_PREFIX}-(?:[${ALPHABET}]{4}-)*[${ALPHABET}]{2}$`);
    if (!expectedPattern.test(code)) {
        throw new Error('Recovery code must use the exact VH1 format');
    }
    const payloadText = code.slice(RECOVERY_CODE_PREFIX.length + 1).replaceAll('-', '');
    if (payloadText.length !== PAYLOAD_SYMBOLS || formatPayload(payloadText) !== code) {
        throw new Error('Recovery code is not canonical');
    }
    const payload = decodeBase32(payloadText);
    if (payload.length !== RECOVERY_KEY_BYTES + CHECKSUM_BYTES) {
        throw new Error('Recovery code has the wrong length');
    }
    const key = payload.slice(0, RECOVERY_KEY_BYTES);
    const actualChecksum = payload.slice(RECOVERY_KEY_BYTES);
    const expectedChecksum = await checksum(key);
    const valid = constantTimeEqual(actualChecksum, expectedChecksum);
    payload.fill(0);
    actualChecksum.fill(0);
    expectedChecksum.fill(0);
    if (!valid) {
        key.fill(0);
        throw new Error('Recovery code checksum does not match');
    }
    return key;
}

