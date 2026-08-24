import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { unwrapDataKeyV1, wrapDataKeyV1 } from './wrappedDataKey';

const recipient = tweetnacl.box.keyPair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ephemeralSecretKey = Uint8Array.from({ length: 32 }, (_, i) => 101 + i);
const nonce = Uint8Array.from({ length: 24 }, (_, i) => 201 + i);
const key = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

function envelope() {
  return wrapDataKeyV1({
    origin: 'https://happy.example',
    accountId: 'account-1',
    epoch: 7,
    domain: 'session',
    objectId: 'session-1',
    field: 'data-key',
    key,
    recipientPublicKey: recipient.publicKey,
    ephemeralSecretKey,
    nonce,
  });
}

describe('WrappedDataKeyV1', () => {
  it('has a deterministic cross-runtime vector and round-trips', () => {
    const wrapped = envelope();
    expect(wrapped).toMatchInlineSnapshot(`
      {
        "accountId": "account-1",
        "ciphertext": "WFU_1utEnhmAteeJu0rNJO6557Lv2TKdm-U3pbv__a726ief_m7v5RIdltC70F0-gTgoWV1qCgfD3bfhictxoSAlR8Fesi-8ckZ0-VubnXLUolClJUa8lX55S3XcmnefYhhZ5FpWyGbFq8Me0AbZC4pIAs4K_Ibu-wdBRBW19QazbxXuyaSJsHKCicwNt-ygleOdqkNqGhJmsUuwRNkR9LdC2aZAKxDoOS5Ryo2ekCv_lmAIfzB81NqXlts-h2QFcBukwp0gzuJPEaa4dTMoZo11QcVGk8wvVtJBQYw8hg",
        "domain": "session",
        "ephemeralPublicKey": "VxR2nRFr92Q2rnS8eT0sMK0ZA8WaxSc4BcfiaYtBDDY",
        "epoch": 7,
        "field": "data-key",
        "nonce": "ycrLzM3Oz9DR0tPU1dbX2Nna29zd3t_g",
        "objectId": "session-1",
        "origin": "https://happy.example",
        "suite": "vh-e2ee-1",
        "v": 1,
      }
    `);
    expect(unwrapDataKeyV1(wrapped, recipient.secretKey)).toEqual(key);
  });

  it('rejects a valid ciphertext transplanted to another object or epoch', () => {
    const wrapped = envelope();
    expect(unwrapDataKeyV1({ ...wrapped, objectId: 'session-2' }, recipient.secretKey)).toBeNull();
    expect(unwrapDataKeyV1({ ...wrapped, epoch: 8 }, recipient.secretKey)).toBeNull();
    expect(unwrapDataKeyV1(wrapped, new Uint8Array(32))).toBeNull();
  });
});
