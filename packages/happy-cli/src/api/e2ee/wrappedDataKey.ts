import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import {
  E2EE_PROTOCOL_VERSION,
  E2EE_SUITE_V1,
  WrappedDataKeyPlaintextV1Schema,
  WrappedDataKeyV1Schema,
  canonicalizeE2eeJson,
  wrappedDataKeyInnerMatchesOuter,
  type E2eeWrappedDataKeyDomain,
  type WrappedDataKeyPlaintextV1,
  type WrappedDataKeyV1,
} from '@slopus/happy-wire';

const KEY_BYTES = 32;
const NONCE_BYTES = 24;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

function canonicalPlaintext(value: WrappedDataKeyPlaintextV1): Uint8Array {
  return new TextEncoder().encode(canonicalizeE2eeJson(value));
}

export function wrapDataKeyV1(input: {
  origin: string;
  accountId: string;
  epoch: number;
  domain: E2eeWrappedDataKeyDomain;
  objectId: string;
  field: string;
  key: Uint8Array;
  recipientPublicKey: Uint8Array;
  ephemeralSecretKey?: Uint8Array;
  nonce?: Uint8Array;
}): WrappedDataKeyV1 {
  if (input.key.byteLength !== KEY_BYTES || input.recipientPublicKey.byteLength !== KEY_BYTES) {
    throw new Error('wrapped data key inputs must be exactly 32 bytes');
  }
  const ephemeral = input.ephemeralSecretKey
    ? tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(input.ephemeralSecretKey))
    : tweetnacl.box.keyPair();
  const nonce = input.nonce ? new Uint8Array(input.nonce) : new Uint8Array(randomBytes(NONCE_BYTES));
  if (nonce.byteLength !== NONCE_BYTES) throw new Error('wrapped data key nonce must be exactly 24 bytes');
  const plaintext = WrappedDataKeyPlaintextV1Schema.parse({
    v: E2EE_PROTOCOL_VERSION,
    suite: E2EE_SUITE_V1,
    origin: input.origin,
    accountId: input.accountId,
    epoch: input.epoch,
    domain: input.domain,
    objectId: input.objectId,
    field: input.field,
    key: base64Url(input.key),
  });
  const plaintextBytes = canonicalPlaintext(plaintext);
  const ciphertext = (() => {
    try {
      return tweetnacl.box(
        plaintextBytes,
        nonce,
        input.recipientPublicKey,
        ephemeral.secretKey,
      );
    } finally {
      plaintextBytes.fill(0);
      ephemeral.secretKey.fill(0);
    }
  })();
  return WrappedDataKeyV1Schema.parse({
    v: plaintext.v,
    suite: plaintext.suite,
    origin: plaintext.origin,
    accountId: plaintext.accountId,
    epoch: plaintext.epoch,
    domain: plaintext.domain,
    objectId: plaintext.objectId,
    field: plaintext.field,
    ephemeralPublicKey: base64Url(ephemeral.publicKey),
    nonce: base64Url(nonce),
    ciphertext: base64Url(ciphertext),
  });
}

export function unwrapDataKeyV1(
  rawEnvelope: unknown,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  if (recipientSecretKey.byteLength !== KEY_BYTES) return null;
  const parsed = WrappedDataKeyV1Schema.safeParse(rawEnvelope);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  const opened = tweetnacl.box.open(
    Buffer.from(envelope.ciphertext, 'base64url'),
    Buffer.from(envelope.nonce, 'base64url'),
    Buffer.from(envelope.ephemeralPublicKey, 'base64url'),
    recipientSecretKey,
  );
  if (!opened) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(opened);
    const raw = JSON.parse(text) as unknown;
    const plaintext = WrappedDataKeyPlaintextV1Schema.parse(raw);
    if (text !== canonicalizeE2eeJson(plaintext) || !wrappedDataKeyInnerMatchesOuter(envelope, plaintext)) {
      return null;
    }
    return new Uint8Array(Buffer.from(plaintext.key, 'base64url'));
  } catch {
    return null;
  } finally {
    opened.fill(0);
  }
}
