import { describe, expect, it } from 'vitest';
import { decryptStoredE2eePayload, encryptStoredE2eePayload } from './storedCrypto';

const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => 255 - index));
const nonce = new Uint8Array(Array.from({ length: 12 }, (_, index) => index));

describe('vh-e2ee-1 stored envelope crypto', () => {
  it('round-trips a fixed stored payload', () => {
    const plaintext = new TextEncoder().encode('task title that must not reach the relay');
    const envelope = encryptStoredE2eePayload({
      key,
      origin: 'https://happy.example',
      accountId: 'account-1',
      epoch: 3,
      domain: 'tasks',
      objectId: 'vh.board-tasks.v1',
      field: 'value',
      plaintext,
      nonce,
    });
    expect(envelope.ciphertext).not.toContain('task');
    expect(decryptStoredE2eePayload(key, envelope)).toEqual(plaintext);
  });

  it('binds domain, object, field, epoch and nonce through AAD', () => {
    const envelope = encryptStoredE2eePayload({
      key,
      origin: 'https://happy.example',
      accountId: 'account-1',
      epoch: 3,
      domain: 'notes',
      objectId: 'vh.note.v1.abc',
      field: 'value',
      plaintext: new TextEncoder().encode('private note'),
      nonce,
    });
    for (const tampered of [
      { ...envelope, epoch: 4 },
      { ...envelope, accountId: 'account-2' },
      { ...envelope, origin: 'https://other.example' },
      { ...envelope, domain: 'tasks' },
      { ...envelope, objectId: 'vh.note.v1.other' },
      { ...envelope, field: 'metadata' },
      { ...envelope, nonce: 'AQEBAQEBAQEBAQEB' },
    ]) {
      expect(decryptStoredE2eePayload(key, tampered)).toBeNull();
    }
  });

  it('fails closed for wrong keys, malformed envelopes and modified ciphertext', () => {
    const envelope = encryptStoredE2eePayload({
      key,
      origin: 'https://happy.example',
      accountId: 'account-1',
      epoch: 1,
      domain: 'message',
      objectId: 'message-1',
      field: 'content',
      plaintext: new Uint8Array([1, 2, 3]),
      nonce,
    });
    expect(decryptStoredE2eePayload(new Uint8Array(32).fill(4), envelope)).toBeNull();
    expect(decryptStoredE2eePayload(key, { ...envelope, plaintext: 'leak' })).toBeNull();
    const changed = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    expect(decryptStoredE2eePayload(key, { ...envelope, ciphertext: changed })).toBeNull();
  });
});
