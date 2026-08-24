import * as z from 'zod';

/** Frozen wire suite identifier from specs/2026-08-end-to-end-encryption.md. */
export const E2EE_SUITE_V1 = 'vh-e2ee-1' as const;
export const E2EE_PROTOCOL_VERSION = 1 as const;

export const E2EE_HKDF_SALT_LABEL = 'very-happy/vh-e2ee-1' as const;
export const E2EE_CONNECTION_DOMAIN = 'very-happy/vh-e2ee-1/connection' as const;
export const E2EE_CLIENT_HELLO_DOMAIN = 'very-happy/vh-e2ee-1/handshake/client' as const;
export const E2EE_RUNNER_HELLO_DOMAIN = 'very-happy/vh-e2ee-1/handshake/runner' as const;
export const E2EE_RECOVERY_CAPSULE_DOMAIN = 'very-happy/vh-e2ee-1/recovery-capsule' as const;
export const E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN = 'very-happy/vh-e2ee-1/control-device-root-envelope' as const;

export const E2EE_CONNECTION_HKDF_OUTPUT_BYTES = 104 as const;
export const E2EE_AES_KEY_BYTES = 32 as const;
export const E2EE_GCM_NONCE_PREFIX_BYTES = 4 as const;
export const E2EE_GCM_NONCE_BYTES = 12 as const;
export const E2EE_CONNECTION_ID_BYTES = 32 as const;
export const E2EE_HANDSHAKE_NONCE_BYTES = 32 as const;
export const E2EE_HANDSHAKE_MAC_BYTES = 32 as const;
export const E2EE_MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
export const E2EE_MAX_UINT64 = 18_446_744_073_709_551_615n;

const textEncoder = new TextEncoder();
const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('Canonical JSON rejects unpaired UTF-16 surrogates');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('Canonical JSON rejects unpaired UTF-16 surrogates');
    }
  }
}

function isUnicodeScalarString(value: string): boolean {
  try {
    assertUnicodeScalarString(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalizeJsonInner(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers');
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }

  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not support cyclic values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalizeJsonInner(item, ancestors)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON only supports plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Canonical JSON does not support symbol keys');
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key);
        if (record[key] === undefined) {
          throw new TypeError('Canonical JSON does not support undefined object values');
        }
        return `${JSON.stringify(key)}:${canonicalizeJsonInner(record[key], ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * RFC 8785/JCS-compatible encoding for the JSON value subset used by the
 * frozen E2EE transcripts. It is deliberately runtime-neutral: no Buffer,
 * locale-sensitive sorting, replacer, or implicit toJSON conversion.
 */
export function canonicalizeE2eeJson(value: CanonicalJsonValue): string {
  return canonicalizeJsonInner(value, new Set());
}

export function encodeCanonicalE2eeJson(value: CanonicalJsonValue): Uint8Array {
  return textEncoder.encode(canonicalizeE2eeJson(value));
}

export type Base64UrlByteBounds = {
  exactBytes?: number;
  minBytes?: number;
  maxBytes?: number;
};

/** Validate unpadded, canonical base64url without decoding or using Buffer. */
export function isCanonicalBase64Url(value: string, bounds: Base64UrlByteBounds = {}): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return false;

  const remainder = value.length % 4;
  if (remainder === 2) {
    const last = base64UrlAlphabet.indexOf(value[value.length - 1] ?? '');
    if (last < 0 || (last & 0x0f) !== 0) return false;
  } else if (remainder === 3) {
    const last = base64UrlAlphabet.indexOf(value[value.length - 1] ?? '');
    if (last < 0 || (last & 0x03) !== 0) return false;
  }

  const decodedBytes = Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  if (bounds.exactBytes !== undefined && decodedBytes !== bounds.exactBytes) return false;
  if (bounds.minBytes !== undefined && decodedBytes < bounds.minBytes) return false;
  if (bounds.maxBytes !== undefined && decodedBytes > bounds.maxBytes) return false;
  return true;
}

function base64UrlSchema(bounds: Base64UrlByteBounds) {
  return z.string().refine((value) => isCanonicalBase64Url(value, bounds), {
    message: 'must be canonical unpadded base64url with the required decoded length',
  });
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

const boundedOpaqueIdSchema = z
  .string()
  .min(1)
  .refine(isUnicodeScalarString, { message: 'must contain valid Unicode scalar values' })
  .refine((value) => utf8Length(value) <= 256, { message: 'must be at most 256 UTF-8 bytes' });

const boundedFieldSchema = z
  .string()
  .min(1)
  .refine(isUnicodeScalarString, { message: 'must contain valid Unicode scalar values' })
  .refine((value) => utf8Length(value) <= 128, { message: 'must be at most 128 UTF-8 bytes' });

const methodSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, {
  message: 'must be a bounded ASCII protocol method',
});

export const e2eeOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && url.origin === value;
  } catch {
    return false;
  }
}, { message: 'must be a normalized HTTP(S) origin without path, query, or fragment' });

export const e2eeEpochSchema = z.number().int().min(1).max(0x7fff_ffff);
export const e2eeNonceSchema = base64UrlSchema({ exactBytes: E2EE_GCM_NONCE_BYTES });
export const e2eeConnectionIdSchema = base64UrlSchema({ exactBytes: E2EE_CONNECTION_ID_BYTES });
export const e2eeHandshakeNonceSchema = base64UrlSchema({ exactBytes: E2EE_HANDSHAKE_NONCE_BYTES });
export const e2eeHandshakeMacSchema = base64UrlSchema({ exactBytes: E2EE_HANDSHAKE_MAC_BYTES });
export const e2eeCiphertextSchema = base64UrlSchema({ minBytes: 16, maxBytes: E2EE_MAX_CIPHERTEXT_BYTES });
export const e2eePublicKeySchema = base64UrlSchema({ exactBytes: 32 });
export const e2eeSignatureSchema = base64UrlSchema({ exactBytes: 64 });
export const e2eeSecretboxNonceSchema = base64UrlSchema({ exactBytes: 24 });

/**
 * Complete RRK-wrapped recovery container. The relay stores the canonical
 * serialization of this object as an opaque value; it must never persist only
 * the inner ciphertext because the authenticated context would be lost.
 */
export const RecoveryKeyringCapsuleV1Schema = z.strictObject({
  v: z.literal(E2EE_PROTOCOL_VERSION),
  domain: z.literal(E2EE_RECOVERY_CAPSULE_DOMAIN),
  suite: z.literal(E2EE_SUITE_V1),
  origin: e2eeOriginSchema,
  accountId: boundedOpaqueIdSchema,
  currentEpoch: e2eeEpochSchema,
  recoveryAuthorityPublicKey: e2eePublicKeySchema,
  nonce: e2eeSecretboxNonceSchema,
  ciphertext: base64UrlSchema({ minBytes: 16, maxBytes: 64 * 1024 }),
  signature: e2eeSignatureSchema,
});
export type RecoveryKeyringCapsuleV1 = z.infer<typeof RecoveryKeyringCapsuleV1Schema>;

const controlDeviceRootAuthorizerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('recovery') }),
  z.strictObject({ kind: z.literal('device'), deviceId: boundedOpaqueIdSchema }),
]);

export const ControlDeviceRootEnvelopeHeaderV1Schema = z.strictObject({
  v: z.literal(E2EE_PROTOCOL_VERSION),
  domain: z.literal(E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN),
  suite: z.literal(E2EE_SUITE_V1),
  origin: e2eeOriginSchema,
  accountId: boundedOpaqueIdSchema,
  deviceId: boundedOpaqueIdSchema,
  keyEpoch: e2eeEpochSchema,
  ephemeralPublicKey: e2eePublicKeySchema,
  nonce: e2eeSecretboxNonceSchema,
  ciphertext: base64UrlSchema({ minBytes: 16, maxBytes: 128 * 1024 }),
  authorizer: controlDeviceRootAuthorizerSchema,
});
export type ControlDeviceRootEnvelopeHeaderV1 = z.infer<typeof ControlDeviceRootEnvelopeHeaderV1Schema>;

export const ControlDeviceRootEnvelopeV1Schema = z.strictObject({
  ...ControlDeviceRootEnvelopeHeaderV1Schema.shape,
  signature: e2eeSignatureSchema,
});
export type ControlDeviceRootEnvelopeV1 = z.infer<typeof ControlDeviceRootEnvelopeV1Schema>;

export function controlDeviceRootEnvelopeSignatureTranscript(
  envelope: ControlDeviceRootEnvelopeHeaderV1 | ControlDeviceRootEnvelopeV1,
): Uint8Array {
  const parsed = ControlDeviceRootEnvelopeHeaderV1Schema.parse({
    v: envelope.v,
    domain: envelope.domain,
    suite: envelope.suite,
    origin: envelope.origin,
    accountId: envelope.accountId,
    deviceId: envelope.deviceId,
    keyEpoch: envelope.keyEpoch,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    authorizer: envelope.authorizer,
  });
  return encodeCanonicalE2eeJson(parsed);
}

export const e2eeStoredDomainSchema = z.enum([
  'session',
  'machine',
  'message',
  'settings',
  'kv',
  'notes',
  'tasks',
  'artifact',
  'attachment',
  'access-key',
]);
export type E2eeStoredDomain = z.infer<typeof e2eeStoredDomainSchema>;

export const e2eeCapabilitySchema = z.enum(['e2ee:unlock', 'e2ee:control', 'e2ee:runner']);
export type E2eeCapability = z.infer<typeof e2eeCapabilitySchema>;

/** Public socket identity fields. The bearer session remains the authority. */
export const E2eeSocketIdentityV1Schema = z.strictObject({
  cryptoMode: z.literal('e2ee-v1'),
  e2eeProtocol: z.literal(E2EE_SUITE_V1),
  deviceId: boundedOpaqueIdSchema,
  cryptoEpoch: e2eeEpochSchema,
});
export type E2eeSocketIdentityV1 = z.infer<typeof E2eeSocketIdentityV1Schema>;

export const e2eeWrappedDataKeyDomainSchema = z.enum(['session', 'machine', 'artifact', 'attachment', 'access-key']);
export type E2eeWrappedDataKeyDomain = z.infer<typeof e2eeWrappedDataKeyDomainSchema>;

export const WrappedDataKeyHeaderV1Schema = z.strictObject({
  v: z.literal(E2EE_PROTOCOL_VERSION),
  suite: z.literal(E2EE_SUITE_V1),
  origin: e2eeOriginSchema,
  accountId: boundedOpaqueIdSchema,
  epoch: e2eeEpochSchema,
  domain: e2eeWrappedDataKeyDomainSchema,
  objectId: boundedOpaqueIdSchema,
  field: boundedFieldSchema,
  ephemeralPublicKey: e2eePublicKeySchema,
  nonce: e2eeSecretboxNonceSchema,
});
export type WrappedDataKeyHeaderV1 = z.infer<typeof WrappedDataKeyHeaderV1Schema>;

export const WrappedDataKeyV1Schema = z.strictObject({
  ...WrappedDataKeyHeaderV1Schema.shape,
  ciphertext: base64UrlSchema({ minBytes: 16, maxBytes: 4 * 1024 }),
});
export type WrappedDataKeyV1 = z.infer<typeof WrappedDataKeyV1Schema>;

/**
 * crypto_box has no detached AAD. Implementations encrypt this exact inner
 * object and compare every duplicated header field with the outer envelope
 * before accepting `key`; otherwise the relay could transplant a valid DEK
 * between sessions, machines, epochs, or accounts.
 */
export const WrappedDataKeyPlaintextV1Schema = z.strictObject({
  v: z.literal(E2EE_PROTOCOL_VERSION),
  suite: z.literal(E2EE_SUITE_V1),
  origin: e2eeOriginSchema,
  accountId: boundedOpaqueIdSchema,
  epoch: e2eeEpochSchema,
  domain: e2eeWrappedDataKeyDomainSchema,
  objectId: boundedOpaqueIdSchema,
  field: boundedFieldSchema,
  key: base64UrlSchema({ exactBytes: 32 }),
});
export type WrappedDataKeyPlaintextV1 = z.infer<typeof WrappedDataKeyPlaintextV1Schema>;

export function wrappedDataKeyInnerMatchesOuter(
  envelope: WrappedDataKeyV1,
  plaintext: WrappedDataKeyPlaintextV1,
): boolean {
  const outer = WrappedDataKeyV1Schema.safeParse(envelope);
  const inner = WrappedDataKeyPlaintextV1Schema.safeParse(plaintext);
  return outer.success && inner.success
    && outer.data.v === inner.data.v
    && outer.data.suite === inner.data.suite
    && outer.data.origin === inner.data.origin
    && outer.data.accountId === inner.data.accountId
    && outer.data.epoch === inner.data.epoch
    && outer.data.domain === inner.data.domain
    && outer.data.objectId === inner.data.objectId
    && outer.data.field === inner.data.field;
}

export const StoredE2eeHeaderV1Schema = z.strictObject({
  v: z.literal(E2EE_PROTOCOL_VERSION),
  suite: z.literal(E2EE_SUITE_V1),
  origin: e2eeOriginSchema,
  accountId: boundedOpaqueIdSchema,
  epoch: e2eeEpochSchema,
  domain: e2eeStoredDomainSchema,
  objectId: boundedOpaqueIdSchema,
  field: boundedFieldSchema,
  nonce: e2eeNonceSchema,
});
export type StoredE2eeHeaderV1 = z.infer<typeof StoredE2eeHeaderV1Schema>;

export const StoredE2eeEnvelopeV1Schema = z.strictObject({
  ...StoredE2eeHeaderV1Schema.shape,
  ciphertext: e2eeCiphertextSchema,
});
export type StoredE2eeEnvelopeV1 = z.infer<typeof StoredE2eeEnvelopeV1Schema>;

export function storedE2eeEnvelopeAad(envelope: StoredE2eeHeaderV1 | StoredE2eeEnvelopeV1): Uint8Array {
  const parsed = StoredE2eeHeaderV1Schema.parse({
    v: envelope.v,
    suite: envelope.suite,
    origin: envelope.origin,
    accountId: envelope.accountId,
    epoch: envelope.epoch,
    domain: envelope.domain,
    objectId: envelope.objectId,
    field: envelope.field,
    nonce: envelope.nonce,
  });
  return encodeCanonicalE2eeJson({
    v: parsed.v,
    suite: parsed.suite,
    origin: parsed.origin,
    accountId: parsed.accountId,
    epoch: parsed.epoch,
    domain: parsed.domain,
    objectId: parsed.objectId,
    field: parsed.field,
    nonce: parsed.nonce,
  });
}

export const e2eeControlDirectionSchema = z.enum(['control-to-runner', 'runner-to-control']);
export type E2eeControlDirection = z.infer<typeof e2eeControlDirectionSchema>;

export const e2eeUint64DecimalSchema = z.string().refine((value) => {
  // uint64 decimal is at most 20 digits. Bound before BigInt conversion so an
  // attacker cannot turn a tiny control frame into an expensive huge integer.
  if (value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= E2EE_MAX_UINT64;
  } catch {
    return false;
  }
}, { message: 'must be a canonical uint64 decimal string' });
export type E2eeUint64Decimal = z.infer<typeof e2eeUint64DecimalSchema>;

export const ControlFrameHeaderV1Schema = z.strictObject({
  v: z.literal(E2EE_PROTOCOL_VERSION),
  suite: z.literal(E2EE_SUITE_V1),
  accountId: boundedOpaqueIdSchema,
  deviceId: boundedOpaqueIdSchema,
  connectionId: e2eeConnectionIdSchema,
  epoch: e2eeEpochSchema,
  direction: e2eeControlDirectionSchema,
  counter: e2eeUint64DecimalSchema,
  method: methodSchema,
  objectId: boundedOpaqueIdSchema,
  requestId: boundedOpaqueIdSchema,
  nonce: e2eeNonceSchema,
});
export type ControlFrameHeaderV1 = z.infer<typeof ControlFrameHeaderV1Schema>;

export const ControlFrameV1Schema = z.strictObject({
  ...ControlFrameHeaderV1Schema.shape,
  ciphertext: e2eeCiphertextSchema,
});
export type ControlFrameV1 = z.infer<typeof ControlFrameV1Schema>;

export function controlFrameV1Aad(frame: ControlFrameHeaderV1 | ControlFrameV1): Uint8Array {
  const parsed = ControlFrameHeaderV1Schema.parse({
    v: frame.v,
    suite: frame.suite,
    accountId: frame.accountId,
    deviceId: frame.deviceId,
    connectionId: frame.connectionId,
    epoch: frame.epoch,
    direction: frame.direction,
    counter: frame.counter,
    method: frame.method,
    objectId: frame.objectId,
    requestId: frame.requestId,
    nonce: frame.nonce,
  });
  return encodeCanonicalE2eeJson({
    v: parsed.v,
    suite: parsed.suite,
    accountId: parsed.accountId,
    deviceId: parsed.deviceId,
    connectionId: parsed.connectionId,
    epoch: parsed.epoch,
    direction: parsed.direction,
    counter: parsed.counter,
    method: parsed.method,
    objectId: parsed.objectId,
    requestId: parsed.requestId,
    nonce: parsed.nonce,
  });
}

const handshakeCommonShape = {
  v: z.literal(E2EE_PROTOCOL_VERSION),
  suite: z.literal(E2EE_SUITE_V1),
  origin: e2eeOriginSchema,
  accountId: boundedOpaqueIdSchema,
  machineId: boundedOpaqueIdSchema,
  deviceId: boundedOpaqueIdSchema,
  epoch: e2eeEpochSchema,
  clientNonce: e2eeHandshakeNonceSchema,
};

export const E2eeClientHelloV1Schema = z.strictObject({
  ...handshakeCommonShape,
  phase: z.literal('client-hello'),
  mac: e2eeHandshakeMacSchema,
});
export type E2eeClientHelloV1 = z.infer<typeof E2eeClientHelloV1Schema>;

export const E2eeRunnerHelloV1Schema = z.strictObject({
  ...handshakeCommonShape,
  phase: z.literal('runner-hello'),
  daemonNonce: e2eeHandshakeNonceSchema,
  bootId: e2eeHandshakeNonceSchema,
  mac: e2eeHandshakeMacSchema,
});
export type E2eeRunnerHelloV1 = z.infer<typeof E2eeRunnerHelloV1Schema>;

export const E2eeHandshakeV1Schema = z.discriminatedUnion('phase', [
  E2eeClientHelloV1Schema,
  E2eeRunnerHelloV1Schema,
]);
export type E2eeHandshakeV1 = z.infer<typeof E2eeHandshakeV1Schema>;

export function e2eeClientHelloMacTranscript(hello: E2eeClientHelloV1): Uint8Array {
  const parsed = E2eeClientHelloV1Schema.parse(hello);
  return encodeCanonicalE2eeJson({
    domain: E2EE_CLIENT_HELLO_DOMAIN,
    v: parsed.v,
    suite: parsed.suite,
    phase: parsed.phase,
    origin: parsed.origin,
    accountId: parsed.accountId,
    machineId: parsed.machineId,
    deviceId: parsed.deviceId,
    epoch: parsed.epoch,
    clientNonce: parsed.clientNonce,
  });
}

export function e2eeRunnerHelloMacTranscript(hello: E2eeRunnerHelloV1): Uint8Array {
  const parsed = E2eeRunnerHelloV1Schema.parse(hello);
  return encodeCanonicalE2eeJson({
    domain: E2EE_RUNNER_HELLO_DOMAIN,
    v: parsed.v,
    suite: parsed.suite,
    phase: parsed.phase,
    origin: parsed.origin,
    accountId: parsed.accountId,
    machineId: parsed.machineId,
    deviceId: parsed.deviceId,
    epoch: parsed.epoch,
    clientNonce: parsed.clientNonce,
    daemonNonce: parsed.daemonNonce,
    bootId: parsed.bootId,
  });
}

export const E2eeConnectionKdfTranscriptSchema = z.strictObject({
  domain: z.literal(E2EE_CONNECTION_DOMAIN),
  accountId: boundedOpaqueIdSchema,
  machineId: boundedOpaqueIdSchema,
  deviceId: boundedOpaqueIdSchema,
  clientNonce: e2eeHandshakeNonceSchema,
  daemonNonce: e2eeHandshakeNonceSchema,
  bootId: e2eeHandshakeNonceSchema,
});
export type E2eeConnectionKdfTranscript = z.infer<typeof E2eeConnectionKdfTranscriptSchema>;

export function e2eeConnectionKdfTranscript(hello: E2eeRunnerHelloV1): Uint8Array {
  const parsed = E2eeRunnerHelloV1Schema.parse(hello);
  return encodeCanonicalE2eeJson({
    domain: E2EE_CONNECTION_DOMAIN,
    accountId: parsed.accountId,
    machineId: parsed.machineId,
    deviceId: parsed.deviceId,
    clientNonce: parsed.clientNonce,
    daemonNonce: parsed.daemonNonce,
    bootId: parsed.bootId,
  });
}

export type E2eeConnectionKeyMaterial = {
  controlToRunnerKey: Uint8Array;
  runnerToControlKey: Uint8Array;
  controlToRunnerNoncePrefix: Uint8Array;
  runnerToControlNoncePrefix: Uint8Array;
  connectionId: Uint8Array;
};

/** Split already-derived HKDF output. This helper does not perform cryptography. */
export function splitE2eeConnectionKeyMaterial(material: Uint8Array): E2eeConnectionKeyMaterial {
  if (material.byteLength !== E2EE_CONNECTION_HKDF_OUTPUT_BYTES) {
    throw new RangeError(`connection HKDF output must be exactly ${E2EE_CONNECTION_HKDF_OUTPUT_BYTES} bytes`);
  }
  return {
    controlToRunnerKey: material.slice(0, 32),
    runnerToControlKey: material.slice(32, 64),
    controlToRunnerNoncePrefix: material.slice(64, 68),
    runnerToControlNoncePrefix: material.slice(68, 72),
    connectionId: material.slice(72, 104),
  };
}

/** Construct the frozen 4-byte prefix + big-endian uint64 GCM nonce. */
export function buildE2eeCounterNonce(prefix: Uint8Array, counter: E2eeUint64Decimal): Uint8Array {
  if (prefix.byteLength !== E2EE_GCM_NONCE_PREFIX_BYTES) {
    throw new RangeError(`nonce prefix must be exactly ${E2EE_GCM_NONCE_PREFIX_BYTES} bytes`);
  }
  const parsed = e2eeUint64DecimalSchema.parse(counter);
  let remaining = BigInt(parsed);
  const nonce = new Uint8Array(E2EE_GCM_NONCE_BYTES);
  nonce.set(prefix, 0);
  for (let index = nonce.length - 1; index >= E2EE_GCM_NONCE_PREFIX_BYTES; index -= 1) {
    nonce[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return nonce;
}

/** Public nonce comparison; callers must reject before attempting AEAD open. */
export function controlFrameV1HasExpectedNonce(frame: ControlFrameV1, prefix: Uint8Array): boolean {
  const parsed = ControlFrameV1Schema.safeParse(frame);
  if (!parsed.success) return false;
  let expected: Uint8Array;
  try {
    expected = buildE2eeCounterNonce(prefix, parsed.data.counter);
  } catch {
    return false;
  }
  const encoded = parsed.data.nonce;
  // A 12-byte base64url value is always 16 ASCII characters. Decode this
  // protocol-sized public field locally to avoid Buffer/atob runtime drift.
  const actual = new Uint8Array(E2EE_GCM_NONCE_BYTES);
  for (let input = 0, output = 0; input < encoded.length; input += 4, output += 3) {
    const a = base64UrlAlphabet.indexOf(encoded[input]);
    const b = base64UrlAlphabet.indexOf(encoded[input + 1]);
    const c = base64UrlAlphabet.indexOf(encoded[input + 2]);
    const d = base64UrlAlphabet.indexOf(encoded[input + 3]);
    actual[output] = (a << 2) | (b >> 4);
    actual[output + 1] = ((b & 0x0f) << 4) | (c >> 2);
    actual[output + 2] = ((c & 0x03) << 6) | d;
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= actual[index] ^ expected[index];
  return mismatch === 0;
}

export const StrictExpectedNextStateSchema = z.strictObject({
  expectedNext: e2eeUint64DecimalSchema.nullable(),
});
export type StrictExpectedNextState = z.infer<typeof StrictExpectedNextStateSchema>;

export type StrictExpectedNextCheck =
  | { ok: true; nextState: StrictExpectedNextState; exhaustedAfterCommit: boolean }
  | { ok: false; reason: 'invalid' | 'duplicate' | 'gap' | 'exhausted' };

export function initialStrictExpectedNextState(): StrictExpectedNextState {
  return { expectedNext: '0' };
}

/**
 * Pure two-phase counter check. The caller commits nextState only after AEAD
 * authentication and outer/inner header comparison have both succeeded.
 */
export function checkStrictExpectedNext(
  state: StrictExpectedNextState,
  receivedCounter: string,
): StrictExpectedNextCheck {
  const parsedState = StrictExpectedNextStateSchema.safeParse(state);
  const parsedCounter = e2eeUint64DecimalSchema.safeParse(receivedCounter);
  if (!parsedState.success || !parsedCounter.success) return { ok: false, reason: 'invalid' };
  if (parsedState.data.expectedNext === null) return { ok: false, reason: 'exhausted' };

  const expected = BigInt(parsedState.data.expectedNext);
  const received = BigInt(parsedCounter.data);
  if (received < expected) return { ok: false, reason: 'duplicate' };
  if (received > expected) return { ok: false, reason: 'gap' };
  if (received === E2EE_MAX_UINT64) {
    return { ok: true, nextState: { expectedNext: null }, exhaustedAfterCommit: true };
  }
  return {
    ok: true,
    nextState: { expectedNext: (received + 1n).toString() },
    exhaustedAfterCommit: false,
  };
}
