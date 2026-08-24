import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  E2EE_CONNECTION_HKDF_OUTPUT_BYTES,
  E2EE_HKDF_SALT_LABEL,
  buildE2eeCounterNonce,
  splitE2eeConnectionKeyMaterial,
} from '@slopus/happy-wire';

const SUITE_SALT = createHash('sha256').update(E2EE_HKDF_SALT_LABEL, 'utf8').digest();
const KEY_BYTES = 32;
const PREFIX_BYTES = 4;
const MAX_COUNTER = (1n << 64n) - 1n;

export interface DerivedControlConnection {
  controlToRunnerKey: Uint8Array;
  runnerToControlKey: Uint8Array;
  controlToRunnerNoncePrefix: Uint8Array;
  runnerToControlNoncePrefix: Uint8Array;
  connectionId: string;
}

export interface EncryptedControlPayload {
  counter: string;
  nonce: string;
  ciphertext: string;
}

function asBytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function toBase64Url(value: Uint8Array): string {
  return asBytes(value).toString('base64url');
}

function transcriptBytes(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : asBytes(value);
}

function parseCounter(value: string): bigint {
  if (value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid control counter');
  const parsed = BigInt(value);
  if (parsed > MAX_COUNTER) throw new Error('control counter overflow');
  return parsed;
}

/**
 * Derive the two directional keys, nonce prefixes and opaque connection id.
 * `canonicalTranscript` must be the frozen JCS handshake transcript from
 * @slopus/happy-wire. Keeping canonicalization outside this crypto primitive
 * makes accidental JSON.stringify drift impossible to hide in this layer.
 */
export function deriveControlConnection(
  machineKey: Uint8Array,
  canonicalTranscript: string | Uint8Array,
): DerivedControlConnection {
  if (machineKey.byteLength !== KEY_BYTES) throw new Error('machine key must be 32 bytes');
  const material = Buffer.from(hkdfSync(
    'sha256',
    asBytes(machineKey),
    SUITE_SALT,
    transcriptBytes(canonicalTranscript),
    E2EE_CONNECTION_HKDF_OUTPUT_BYTES,
  ));
  const split = splitE2eeConnectionKeyMaterial(material);
  return {
    controlToRunnerKey: split.controlToRunnerKey,
    runnerToControlKey: split.runnerToControlKey,
    controlToRunnerNoncePrefix: split.controlToRunnerNoncePrefix,
    runnerToControlNoncePrefix: split.runnerToControlNoncePrefix,
    connectionId: toBase64Url(split.connectionId),
  };
}

export function controlHandshakeMac(machineKey: Uint8Array, canonicalTranscript: string | Uint8Array): string {
  if (machineKey.byteLength !== KEY_BYTES) throw new Error('machine key must be 32 bytes');
  return createHmac('sha256', asBytes(machineKey))
    .update(transcriptBytes(canonicalTranscript))
    .digest('base64url');
}

export function verifyControlHandshakeMac(
  machineKey: Uint8Array,
  canonicalTranscript: string | Uint8Array,
  mac: string,
): boolean {
  let supplied: Buffer;
  try {
    supplied = Buffer.from(mac, 'base64url');
  } catch {
    return false;
  }
  const expected = Buffer.from(controlHandshakeMac(machineKey, canonicalTranscript), 'base64url');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function nonceForControlCounter(prefix: Uint8Array, counterValue: string): Uint8Array {
  if (prefix.byteLength !== PREFIX_BYTES) throw new Error('nonce prefix must be 4 bytes');
  parseCounter(counterValue);
  return buildE2eeCounterNonce(prefix, counterValue);
}

export function encryptControlPayload(
  key: Uint8Array,
  noncePrefix: Uint8Array,
  counter: string,
  canonicalAad: string | Uint8Array,
  plaintext: Uint8Array,
): EncryptedControlPayload {
  if (key.byteLength !== KEY_BYTES) throw new Error('control key must be 32 bytes');
  const nonce = nonceForControlCounter(noncePrefix, counter);
  const cipher = createCipheriv('aes-256-gcm', asBytes(key), asBytes(nonce));
  cipher.setAAD(transcriptBytes(canonicalAad));
  const encrypted = Buffer.concat([cipher.update(asBytes(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return { counter, nonce: toBase64Url(nonce), ciphertext: encrypted.toString('base64url') };
}

export function decryptControlPayload(
  key: Uint8Array,
  noncePrefix: Uint8Array,
  expectedCounter: string,
  canonicalAad: string | Uint8Array,
  payload: EncryptedControlPayload,
): Uint8Array | null {
  if (payload.counter !== expectedCounter || key.byteLength !== KEY_BYTES) return null;
  let nonce: Buffer;
  let bundle: Buffer;
  try {
    nonce = Buffer.from(payload.nonce, 'base64url');
    bundle = Buffer.from(payload.ciphertext, 'base64url');
  } catch {
    return null;
  }
  const expectedNonce = nonceForControlCounter(noncePrefix, expectedCounter);
  if (nonce.length !== expectedNonce.byteLength || !timingSafeEqual(nonce, asBytes(expectedNonce))) return null;
  if (bundle.length < 16) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', asBytes(key), nonce);
    decipher.setAAD(transcriptBytes(canonicalAad));
    decipher.setAuthTag(bundle.subarray(bundle.length - 16));
    return new Uint8Array(Buffer.concat([
      decipher.update(bundle.subarray(0, bundle.length - 16)),
      decipher.final(),
    ]));
  } catch {
    return null;
  }
}

/** Strict ordered-channel counter. Call commit only after AEAD and header checks. */
export class StrictControlCounter {
  private next: bigint | null = 0n;

  expected(): string {
    if (this.next === null) throw new Error('control counter exhausted');
    return this.next.toString(10);
  }

  matches(value: string): boolean {
    try {
      return this.next !== null && parseCounter(value) === this.next;
    } catch {
      return false;
    }
  }

  commit(value: string): void {
    if (!this.matches(value)) throw new Error('unexpected control counter');
    if (this.next === MAX_COUNTER) {
      this.next = null;
      return;
    }
    this.next! += 1n;
  }

  exhausted(): boolean {
    return this.next === null;
  }
}
