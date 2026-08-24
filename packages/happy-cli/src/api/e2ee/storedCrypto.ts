import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  E2EE_PROTOCOL_VERSION,
  E2EE_SUITE_V1,
  StoredE2eeEnvelopeV1Schema,
  storedE2eeEnvelopeAad,
  type E2eeStoredDomain,
  type StoredE2eeEnvelopeV1,
  type StoredE2eeHeaderV1,
} from '@slopus/happy-wire';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function keyBuffer(key: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new Error('stored E2EE key must be 32 bytes');
  return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
}

export function encryptStoredE2eePayload(input: {
  key: Uint8Array;
  origin: string;
  accountId: string;
  epoch: number;
  domain: E2eeStoredDomain;
  objectId: string;
  field: string;
  plaintext: Uint8Array;
  nonce?: Uint8Array;
}): StoredE2eeEnvelopeV1 {
  const nonce = input.nonce ? new Uint8Array(input.nonce) : new Uint8Array(randomBytes(NONCE_BYTES));
  if (nonce.byteLength !== NONCE_BYTES) throw new Error('stored E2EE nonce must be 12 bytes');
  const header: StoredE2eeHeaderV1 = {
    v: E2EE_PROTOCOL_VERSION,
    suite: E2EE_SUITE_V1,
    origin: input.origin,
    accountId: input.accountId,
    epoch: input.epoch,
    domain: input.domain,
    objectId: input.objectId,
    field: input.field,
    nonce: Buffer.from(nonce).toString('base64url'),
  };
  const aad = storedE2eeEnvelopeAad(header);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(input.key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(input.plaintext)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
  return StoredE2eeEnvelopeV1Schema.parse({ ...header, ciphertext });
}

export function decryptStoredE2eePayload(
  key: Uint8Array,
  rawEnvelope: unknown,
): Uint8Array | null {
  const parsed = StoredE2eeEnvelopeV1Schema.safeParse(rawEnvelope);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  const bundle = Buffer.from(envelope.ciphertext, 'base64url');
  if (nonce.byteLength !== NONCE_BYTES || bundle.byteLength < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBuffer(key), nonce);
    decipher.setAAD(Buffer.from(storedE2eeEnvelopeAad(envelope)));
    decipher.setAuthTag(bundle.subarray(bundle.length - TAG_BYTES));
    return new Uint8Array(Buffer.concat([
      decipher.update(bundle.subarray(0, bundle.length - TAG_BYTES)),
      decipher.final(),
    ]));
  } catch {
    return null;
  }
}
