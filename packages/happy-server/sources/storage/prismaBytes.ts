import * as privacyKit from 'privacy-kit';

/**
 * Decode an API base64 field into the Node Buffer shape expected by Prisma's
 * PostgreSQL adapters. Keep the Buffer instead of wrapping it in a fresh
 * Uint8Array: pglite-prisma-adapter 0.7 can serialize a cross-bundle
 * Uint8Array as an object with numeric keys, which PostgreSQL rejects for
 * bytea columns. Buffer remains a Uint8Array and works with Prisma's Bytes
 * input type as well as the production PostgreSQL client. Decode through
 * privacy-kit first so malformed API values fail closed instead of Node's
 * permissive base64 decoder silently accepting or truncating them.
 */
export function decodePrismaBytes(value: string): Uint8Array<ArrayBuffer> {
    // @types/node models Buffer's backing store as ArrayBufferLike, while the
    // generated Prisma client narrows Bytes inputs to ArrayBuffer. At runtime
    // Buffer.from(base64) owns an ordinary ArrayBuffer and is the intentional
    // adapter-compatible representation.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Invalid base64');
    }
    const decoded = Buffer.from(privacyKit.decodeBase64(value));
    if (decoded.toString('base64') !== value) throw new Error('Invalid base64');
    return decoded as unknown as Uint8Array<ArrayBuffer>;
}
