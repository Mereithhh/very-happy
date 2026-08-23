import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';

export function terminalPublicKeyFromHash(hash: string): Uint8Array | null {
  const value = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('key');
  if (!value) return null;
  try {
    const key = decodeBase64(value, 'base64url');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function buildTerminalApproval(
  accountSecret: Uint8Array,
  contentPublicKey: Uint8Array,
  terminalPublicKey: Uint8Array,
): { legacy: Uint8Array; dataKey: Uint8Array } {
  const dataKeyBundle = new Uint8Array(contentPublicKey.length + 1);
  dataKeyBundle[0] = 0;
  dataKeyBundle.set(contentPublicKey, 1);
  return {
    legacy: encryptBox(accountSecret, terminalPublicKey),
    dataKey: encryptBox(dataKeyBundle, terminalPublicKey),
  };
}
