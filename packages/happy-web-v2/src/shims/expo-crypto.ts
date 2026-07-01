// web shim for expo-crypto using the Web Crypto API (SubtleCrypto + getRandomValues).
export enum CryptoDigestAlgorithm {
  SHA1 = 'SHA-1',
  SHA256 = 'SHA-256',
  SHA384 = 'SHA-384',
  SHA512 = 'SHA-512',
  MD5 = 'MD5', // unsupported by SubtleCrypto; present for type-compat only
}

export async function digest(
  algorithm: CryptoDigestAlgorithm,
  data: Uint8Array,
): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    algorithm,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

export async function digestStringAsync(
  algorithm: CryptoDigestAlgorithm,
  data: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const out = await digest(algorithm, bytes);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function getRandomBytes(byteCount: number): Uint8Array {
  const arr = new Uint8Array(byteCount);
  crypto.getRandomValues(arr);
  return arr;
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return getRandomBytes(byteCount);
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

export const CryptoEncoding = { HEX: 'hex', BASE64: 'base64' } as const;
