/**
 * Encoding and validation primitives for the frozen `vh-e2ee-1` suite.
 *
 * Wire bytes are always canonical, unpadded base64url.  Keeping this separate
 * from the legacy base64 helpers is intentional: accepting padding or the
 * standard `+/` alphabet would give signatures more than one textual wire
 * representation.
 */

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export const E2EE_SUITE = 'vh-e2ee-1' as const;
export const E2EE_DOMAIN_PREFIX = 'very-happy/vh-e2ee-1' as const;

export function encodeBase64UrlCanonical(bytes: Uint8Array): string {
    let binary = '';
    // Avoid a single, potentially stack-overflowing spread for attachment-sized
    // values.  32 KiB stays well below browser argument limits.
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeBase64UrlCanonical(
    value: string,
    limits: { exactBytes?: number; minBytes?: number; maxBytes?: number } = {},
): Uint8Array {
    if (!BASE64URL_RE.test(value) || value.includes('=')) {
        throw new Error('Invalid canonical base64url');
    }
    // A base64 string can never have one residual character.
    if (value.length % 4 === 1) throw new Error('Invalid canonical base64url length');

    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
        + '='.repeat((4 - (value.length % 4)) % 4);
    let binary: string;
    try {
        binary = atob(padded);
    } catch {
        throw new Error('Invalid canonical base64url');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Reject non-zero unused bits and every other alternate spelling.
    if (encodeBase64UrlCanonical(bytes) !== value) {
        throw new Error('Non-canonical base64url');
    }
    if (limits.exactBytes !== undefined && bytes.length !== limits.exactBytes) {
        throw new Error(`Expected ${limits.exactBytes} bytes`);
    }
    if (limits.minBytes !== undefined && bytes.length < limits.minBytes) {
        throw new Error(`Expected at least ${limits.minBytes} bytes`);
    }
    if (limits.maxBytes !== undefined && bytes.length > limits.maxBytes) {
        throw new Error(`Expected at most ${limits.maxBytes} bytes`);
    }
    return bytes;
}

export function secureRandomBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0 || length > 65_536) {
        throw new Error('Invalid random byte length');
    }
    return crypto.getRandomValues(new Uint8Array(length));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    const length = Math.max(a.length, b.length);
    let difference = a.length ^ b.length;
    for (let i = 0; i < length; i++) {
        difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return difference === 0;
}

export function utf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

export function utf8String(value: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

