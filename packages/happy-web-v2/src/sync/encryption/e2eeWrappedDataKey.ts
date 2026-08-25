import sodium from '@/encryption/libsodium.lib';
import {
    WrappedDataKeyPlaintextV1Schema,
    WrappedDataKeyV1Schema,
    canonicalizeE2eeJson,
    wrappedDataKeyInnerMatchesOuter,
    type E2eeWrappedDataKeyDomain,
} from '@slopus/happy-wire';
import { decodeBase64UrlCanonical } from './e2eeEncoding';

export interface ExpectedWrappedDataKeyContext {
    origin: string;
    accountId: string;
    domain: E2eeWrappedDataKeyDomain;
    objectId: string;
    field: string;
}

export async function unwrapE2eeDataKey(
    serialized: string,
    privateKeyForEpoch: (epoch: number) => Uint8Array | null,
    expected: ExpectedWrappedDataKeyContext,
): Promise<Uint8Array | null> {
    let raw: unknown;
    try {
        raw = JSON.parse(serialized) as unknown;
    } catch {
        return null;
    }
    const parsed = WrappedDataKeyV1Schema.safeParse(raw);
    if (!parsed.success) return null;
    const envelope = parsed.data;
    if (serialized !== canonicalizeE2eeJson(envelope)) return null;
    if (envelope.origin !== expected.origin
        || envelope.accountId !== expected.accountId
        || envelope.domain !== expected.domain
        || envelope.objectId !== expected.objectId
        || envelope.field !== expected.field) {
        return null;
    }
    const privateKey = privateKeyForEpoch(envelope.epoch);
    if (!privateKey || privateKey.length !== 32) return null;
    await sodium.ready;
    const opened = sodium.crypto_box_open_easy(
        decodeBase64UrlCanonical(envelope.ciphertext, { minBytes: 16, maxBytes: 4 * 1024 }),
        decodeBase64UrlCanonical(envelope.nonce, { exactBytes: 24 }),
        decodeBase64UrlCanonical(envelope.ephemeralPublicKey, { exactBytes: 32 }),
        privateKey,
    );
    if (!opened) return null;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(opened);
        const plaintext = WrappedDataKeyPlaintextV1Schema.parse(JSON.parse(text) as unknown);
        if (text !== canonicalizeE2eeJson(plaintext)
            || !wrappedDataKeyInnerMatchesOuter(envelope, plaintext)) {
            return null;
        }
        return decodeBase64UrlCanonical(plaintext.key, { exactBytes: 32 });
    } catch {
        return null;
    } finally {
        opened.fill(0);
    }
}
