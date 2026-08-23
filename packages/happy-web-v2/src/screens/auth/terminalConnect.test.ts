import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { terminalPublicKeyFromHash } from './terminalConnect';

describe('terminalPublicKeyFromHash', () => {
  it('accepts exactly one base64url-encoded box public key', () => {
    const key = new Uint8Array(32).fill(7);
    expect(terminalPublicKeyFromHash(`#key=${encodeBase64(key, 'base64url')}`)).toEqual(key);
  });

  it('rejects missing, malformed, and wrong-length keys', () => {
    expect(terminalPublicKeyFromHash('')).toBeNull();
    expect(terminalPublicKeyFromHash('#key=not-base64!')).toBeNull();
    expect(terminalPublicKeyFromHash(`#key=${encodeBase64(new Uint8Array(31), 'base64url')}`)).toBeNull();
  });
});
