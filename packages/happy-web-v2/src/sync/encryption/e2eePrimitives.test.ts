import { describe, expect, it } from 'vitest';
import { decryptE2eeAesGcm, encryptE2eeAesGcm } from './e2eeAesGcm';
import { decodeBase64UrlCanonical, encodeBase64UrlCanonical, utf8, utf8String } from './e2eeEncoding';
import { jcsCanonicalize, parseCanonicalJcs } from './e2eeJcs';

describe('vh-e2ee-1 primitives', () => {
    it('uses one canonical unpadded base64url spelling', () => {
        const bytes = new Uint8Array([0xfb, 0xff, 0xef]);
        expect(encodeBase64UrlCanonical(bytes)).toBe('-__v');
        expect(decodeBase64UrlCanonical('-__v')).toEqual(bytes);
        expect(() => decodeBase64UrlCanonical('+//v')).toThrow(/canonical/);
        expect(() => decodeBase64UrlCanonical('-__v=')).toThrow(/canonical/);
        expect(() => decodeBase64UrlCanonical('A')).toThrow(/length/);
    });

    it('canonicalizes nested JSON and rejects alternate encodings', () => {
        const canonical = '{"a":{"a":true,"b":null},"list":[3,"x"],"z":0}';
        expect(jcsCanonicalize({ z: -0, a: { b: null, a: true }, list: [3, 'x'] })).toBe(canonical);
        expect(parseCanonicalJcs(canonical)).toEqual({ a: { a: true, b: null }, list: [3, 'x'], z: 0 });
        expect(() => parseCanonicalJcs('{"z":0,"a":1}')).toThrow(/Non-canonical/);
        expect(() => parseCanonicalJcs('{"a":1,"a":1}')).toThrow(/Non-canonical/);
        expect(() => jcsCanonicalize({ bad: '\ud800' })).toThrow(/surrogate/);
    });

    it('authenticates raw bytes and AAD with AES-256-GCM', async () => {
        const key = new Uint8Array(32).fill(7);
        const nonce = new Uint8Array(12).fill(9);
        const encrypted = await encryptE2eeAesGcm(key, utf8('terminal bytes\u0000'), utf8('right-header'), nonce);
        expect(utf8String(await decryptE2eeAesGcm(key, encrypted, utf8('right-header'))))
            .toBe('terminal bytes\u0000');
        await expect(decryptE2eeAesGcm(key, encrypted, utf8('wrong-header')))
            .rejects.toThrow(/authentication failed/);
        await expect(decryptE2eeAesGcm(new Uint8Array(32).fill(8), encrypted, utf8('right-header')))
            .rejects.toThrow(/authentication failed/);
    });
});

