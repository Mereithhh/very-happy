import { describe, expect, it } from 'vitest';
import {
  ControlFrameV1Schema,
  E2EE_CONNECTION_DOMAIN,
  E2EE_CONNECTION_HKDF_OUTPUT_BYTES,
  E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
  E2EE_MAX_UINT64,
  E2EE_RECOVERY_CAPSULE_DOMAIN,
  E2EE_SUITE_V1,
  E2eeClientHelloV1Schema,
  E2eeHandshakeV1Schema,
  E2eeRunnerHelloV1Schema,
  E2eeSocketIdentityV1Schema,
  StoredE2eeEnvelopeV1Schema,
  ControlDeviceRootEnvelopeV1Schema,
  RecoveryKeyringCapsuleV1Schema,
  buildE2eeCounterNonce,
  canonicalizeE2eeJson,
  checkStrictExpectedNext,
  controlFrameV1HasExpectedNonce,
  controlFrameV1Aad,
  controlDeviceRootEnvelopeSignatureTranscript,
  e2eeClientHelloMacTranscript,
  e2eeConnectionKdfTranscript,
  e2eeRunnerHelloMacTranscript,
  e2eeUint64DecimalSchema,
  initialStrictExpectedNextState,
  isCanonicalBase64Url,
  splitE2eeConnectionKeyMaterial,
  storedE2eeEnvelopeAad,
  type ControlFrameV1,
  type E2eeClientHelloV1,
  type E2eeRunnerHelloV1,
  type StoredE2eeEnvelopeV1,
} from './e2eeProtocol';

const ZERO_12 = 'AAAAAAAAAAAAAAAA';
const ZERO_16 = 'AAAAAAAAAAAAAAAAAAAAAA';
const ZERO_24 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ZERO_32 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ZERO_64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ONE_32 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const TWO_32 = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
const THREE_32 = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const storedEnvelope: StoredE2eeEnvelopeV1 = {
  v: 1,
  suite: E2EE_SUITE_V1,
  origin: 'https://happy.example',
  accountId: 'account-1',
  epoch: 7,
  domain: 'message',
  objectId: 'session-1/message-9',
  field: 'content',
  nonce: ZERO_12,
  ciphertext: ZERO_16,
};

const controlFrame: ControlFrameV1 = {
  v: 1,
  suite: E2EE_SUITE_V1,
  accountId: 'account-1',
  deviceId: 'device-3',
  connectionId: ZERO_32,
  epoch: 7,
  direction: 'control-to-runner',
  counter: '42',
  method: 'terminal-input',
  objectId: 'terminal-1',
  requestId: 'request-9',
  nonce: ZERO_12,
  ciphertext: ZERO_16,
};

const clientHello: E2eeClientHelloV1 = {
  v: 1,
  suite: E2EE_SUITE_V1,
  phase: 'client-hello',
  origin: 'https://happy.example',
  accountId: 'account-1',
  machineId: 'machine-2',
  deviceId: 'device-3',
  epoch: 7,
  clientNonce: ZERO_32,
  mac: THREE_32,
};

const runnerHello: E2eeRunnerHelloV1 = {
  ...clientHello,
  phase: 'runner-hello',
  daemonNonce: ONE_32,
  bootId: TWO_32,
};

describe('canonical E2EE JSON', () => {
  it('has fixed cross-runtime JSON output', () => {
    expect(canonicalizeE2eeJson({
      z: [true, null, -0, 1e30],
      a: 'line\n\"quoted\"',
      nested: { beta: 2, alpha: 1 },
    })).toBe('{"a":"line\\n\\\"quoted\\\"","nested":{"alpha":1,"beta":2},"z":[true,null,0,1e+30]}');
  });

  it('rejects values outside the JCS-compatible subset', () => {
    expect(() => canonicalizeE2eeJson({ bad: Number.NaN })).toThrow('finite numbers');
    expect(() => canonicalizeE2eeJson({ bad: undefined } as never)).toThrow('undefined');
    expect(() => canonicalizeE2eeJson({ bad: '\ud800' })).toThrow('unpaired');
    expect(() => canonicalizeE2eeJson(new Date() as never)).toThrow('plain objects');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeE2eeJson(cyclic as never)).toThrow('cyclic');
  });
});

describe('canonical base64url', () => {
  it('validates decoded lengths and unused bits without Buffer', () => {
    expect(isCanonicalBase64Url(ZERO_12, { exactBytes: 12 })).toBe(true);
    expect(isCanonicalBase64Url(ZERO_32, { exactBytes: 32 })).toBe(true);
    expect(isCanonicalBase64Url('AA', { exactBytes: 1 })).toBe(true);
    expect(isCanonicalBase64Url('AB', { exactBytes: 1 })).toBe(false);
    expect(isCanonicalBase64Url('AAA', { exactBytes: 2 })).toBe(true);
    expect(isCanonicalBase64Url('AAB', { exactBytes: 2 })).toBe(false);
    expect(isCanonicalBase64Url('AA==', { exactBytes: 1 })).toBe(false);
  });
});

describe('stored E2EE envelope', () => {
  it('strictly parses the frozen wire', () => {
    expect(StoredE2eeEnvelopeV1Schema.parse(storedEnvelope)).toEqual(storedEnvelope);
    expect(StoredE2eeEnvelopeV1Schema.safeParse({ ...storedEnvelope, plaintext: 'nope' }).success).toBe(false);
    expect(StoredE2eeEnvelopeV1Schema.safeParse({ ...storedEnvelope, epoch: 0 }).success).toBe(false);
    expect(StoredE2eeEnvelopeV1Schema.safeParse({ ...storedEnvelope, nonce: ZERO_16 }).success).toBe(false);
    expect(StoredE2eeEnvelopeV1Schema.safeParse({ ...storedEnvelope, ciphertext: 'AA' }).success).toBe(false);
    expect(StoredE2eeEnvelopeV1Schema.safeParse({ ...storedEnvelope, objectId: '\ud800' }).success).toBe(false);
  });

  it('has a fixed ciphertext-free JCS AAD vector', () => {
    const { ciphertext: _ciphertext, ...header } = storedEnvelope;
    expect(text(storedE2eeEnvelopeAad(storedEnvelope))).toBe(
      '{"accountId":"account-1","domain":"message","epoch":7,"field":"content","nonce":"AAAAAAAAAAAAAAAA","objectId":"session-1/message-9","origin":"https://happy.example","suite":"vh-e2ee-1","v":1}',
    );
    expect(storedE2eeEnvelopeAad(header)).toEqual(storedE2eeEnvelopeAad(storedEnvelope));
  });
});

describe('recovery and control-device containers', () => {
  it('strictly validates the complete recovery capsule container', () => {
    const capsule = {
      v: 1 as const,
      domain: E2EE_RECOVERY_CAPSULE_DOMAIN,
      suite: E2EE_SUITE_V1,
      origin: 'https://happy.example',
      accountId: 'account-1',
      currentEpoch: 7,
      recoveryAuthorityPublicKey: ZERO_32,
      nonce: ZERO_24,
      ciphertext: ZERO_16,
      signature: ZERO_64,
    };
    expect(RecoveryKeyringCapsuleV1Schema.parse(capsule)).toEqual(capsule);
    expect(RecoveryKeyringCapsuleV1Schema.safeParse({ ...capsule, innerOnly: true }).success).toBe(false);
    expect(RecoveryKeyringCapsuleV1Schema.safeParse({ ...capsule, origin: 'http://happy.example' }).success).toBe(false);
  });

  it('freezes the explicit ephemeral-X25519 root-envelope wire and signature transcript', () => {
    const envelope = {
      v: 1 as const,
      domain: E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
      suite: E2EE_SUITE_V1,
      origin: 'https://happy.example',
      accountId: 'account-1',
      deviceId: 'device-3',
      keyEpoch: 7,
      ephemeralPublicKey: ZERO_32,
      nonce: ZERO_24,
      ciphertext: ZERO_16,
      authorizer: { kind: 'recovery' as const },
      signature: ZERO_64,
    };
    expect(ControlDeviceRootEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
    expect(text(controlDeviceRootEnvelopeSignatureTranscript(envelope))).toBe(
      '{"accountId":"account-1","authorizer":{"kind":"recovery"},"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA","deviceId":"device-3","domain":"very-happy/vh-e2ee-1/control-device-root-envelope","ephemeralPublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","keyEpoch":7,"nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","origin":"https://happy.example","suite":"vh-e2ee-1","v":1}',
    );
    expect(ControlDeviceRootEnvelopeV1Schema.safeParse({
      ...envelope,
      authorizer: { kind: 'device' },
    }).success).toBe(false);
  });
});

describe('control frame', () => {
  it('strictly parses bounded, canonical fields', () => {
    expect(ControlFrameV1Schema.parse(controlFrame)).toEqual(controlFrame);
    expect(ControlFrameV1Schema.safeParse({ ...controlFrame, extra: true }).success).toBe(false);
    expect(ControlFrameV1Schema.safeParse({ ...controlFrame, direction: 'runner-to-server' }).success).toBe(false);
    expect(ControlFrameV1Schema.safeParse({ ...controlFrame, counter: '042' }).success).toBe(false);
    expect(ControlFrameV1Schema.safeParse({ ...controlFrame, method: 'terminal input' }).success).toBe(false);
  });

  it('rejects uint64 overflow and has a fixed AAD vector', () => {
    const { ciphertext: _ciphertext, ...header } = controlFrame;
    expect(e2eeUint64DecimalSchema.safeParse(E2EE_MAX_UINT64.toString()).success).toBe(true);
    expect(e2eeUint64DecimalSchema.safeParse((E2EE_MAX_UINT64 + 1n).toString()).success).toBe(false);
    expect(e2eeUint64DecimalSchema.safeParse('9'.repeat(100_000)).success).toBe(false);
    expect(text(controlFrameV1Aad(controlFrame))).toBe(
      '{"accountId":"account-1","connectionId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","counter":"42","deviceId":"device-3","direction":"control-to-runner","epoch":7,"method":"terminal-input","nonce":"AAAAAAAAAAAAAAAA","objectId":"terminal-1","requestId":"request-9","suite":"vh-e2ee-1","v":1}',
    );
    expect(controlFrameV1Aad(header)).toEqual(controlFrameV1Aad(controlFrame));
  });
});

describe('authenticated handshake transcripts', () => {
  it('strictly parses both handshake phases and normalized origins', () => {
    expect(E2eeClientHelloV1Schema.parse(clientHello)).toEqual(clientHello);
    expect(E2eeRunnerHelloV1Schema.parse(runnerHello)).toEqual(runnerHello);
    expect(E2eeHandshakeV1Schema.parse(clientHello)).toEqual(clientHello);
    expect(E2eeHandshakeV1Schema.parse(runnerHello)).toEqual(runnerHello);
    expect(E2eeClientHelloV1Schema.safeParse({ ...clientHello, origin: 'https://happy.example/' }).success).toBe(false);
    expect(E2eeClientHelloV1Schema.safeParse({ ...clientHello, serverHint: 'trusted' }).success).toBe(false);
  });

  it('has fixed client and runner HMAC transcript vectors', () => {
    expect(text(e2eeClientHelloMacTranscript(clientHello))).toBe(
      '{"accountId":"account-1","clientNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","deviceId":"device-3","domain":"very-happy/vh-e2ee-1/handshake/client","epoch":7,"machineId":"machine-2","origin":"https://happy.example","phase":"client-hello","suite":"vh-e2ee-1","v":1}',
    );
    expect(text(e2eeRunnerHelloMacTranscript(runnerHello))).toBe(
      '{"accountId":"account-1","bootId":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","clientNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","daemonNonce":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","deviceId":"device-3","domain":"very-happy/vh-e2ee-1/handshake/runner","epoch":7,"machineId":"machine-2","origin":"https://happy.example","phase":"runner-hello","suite":"vh-e2ee-1","v":1}',
    );
  });

  it('has the exact frozen HKDF info vector', () => {
    expect(text(e2eeConnectionKdfTranscript(runnerHello))).toBe(
      '{"accountId":"account-1","bootId":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","clientNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","daemonNonce":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","deviceId":"device-3","domain":"very-happy/vh-e2ee-1/connection","machineId":"machine-2"}',
    );
    expect(E2EE_CONNECTION_DOMAIN).toBe('very-happy/vh-e2ee-1/connection');
  });
});

describe('socket identity', () => {
  it('requires explicit device, epoch, protocol, and E2EE mode', () => {
    const identity = {
      cryptoMode: 'e2ee-v1' as const,
      e2eeProtocol: E2EE_SUITE_V1,
      deviceId: 'device-3',
      cryptoEpoch: 7,
    };
    expect(E2eeSocketIdentityV1Schema.parse(identity)).toEqual(identity);
    expect(E2eeSocketIdentityV1Schema.safeParse({ ...identity, e2eeProtocol: undefined }).success).toBe(false);
    expect(E2eeSocketIdentityV1Schema.safeParse({ ...identity, cryptoEpoch: 0 }).success).toBe(false);
    expect(E2eeSocketIdentityV1Schema.safeParse({ ...identity, downgrade: true }).success).toBe(false);
  });
});

describe('connection key material layout', () => {
  it('splits exactly 104 already-derived bytes without aliasing', () => {
    const material = Uint8Array.from({ length: E2EE_CONNECTION_HKDF_OUTPUT_BYTES }, (_, index) => index);
    const split = splitE2eeConnectionKeyMaterial(material);

    expect([...split.controlToRunnerKey]).toEqual([...material.slice(0, 32)]);
    expect([...split.runnerToControlKey]).toEqual([...material.slice(32, 64)]);
    expect([...split.controlToRunnerNoncePrefix]).toEqual([64, 65, 66, 67]);
    expect([...split.runnerToControlNoncePrefix]).toEqual([68, 69, 70, 71]);
    expect([...split.connectionId]).toEqual([...material.slice(72, 104)]);
    material[0] = 255;
    expect(split.controlToRunnerKey[0]).toBe(0);
    expect(() => splitE2eeConnectionKeyMaterial(new Uint8Array(103))).toThrow('104 bytes');
  });

  it('constructs prefix + big-endian uint64 nonces', () => {
    const prefix = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const counter = '72623859790382856';
    expect([...buildE2eeCounterNonce(prefix, counter)])
      .toEqual([0xaa, 0xbb, 0xcc, 0xdd, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(controlFrameV1HasExpectedNonce({
      ...controlFrame,
      counter,
      nonce: 'qrvM3QECAwQFBgcI',
    }, prefix)).toBe(true);
    expect(controlFrameV1HasExpectedNonce({ ...controlFrame, counter, nonce: ZERO_12 }, prefix)).toBe(false);
    expect(() => buildE2eeCounterNonce(new Uint8Array(3), '0')).toThrow('4 bytes');
  });
});

describe('strict expectedNext state', () => {
  it('returns a candidate state without mutating the committed state', () => {
    const committed = initialStrictExpectedNextState();
    const checked = checkStrictExpectedNext(committed, '0');
    expect(checked).toEqual({
      ok: true,
      nextState: { expectedNext: '1' },
      exhaustedAfterCommit: false,
    });
    expect(committed).toEqual({ expectedNext: '0' });
  });

  it('fails closed on duplicates, gaps, invalid values, and exhaustion', () => {
    expect(checkStrictExpectedNext({ expectedNext: '1' }, '0')).toEqual({ ok: false, reason: 'duplicate' });
    expect(checkStrictExpectedNext({ expectedNext: '1' }, '2')).toEqual({ ok: false, reason: 'gap' });
    expect(checkStrictExpectedNext({ expectedNext: '1' }, '01')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkStrictExpectedNext({ expectedNext: null }, '0')).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('accepts uint64 max once and requires a new handshake afterwards', () => {
    const max = E2EE_MAX_UINT64.toString();
    const checked = checkStrictExpectedNext({ expectedNext: max }, max);
    expect(checked).toEqual({ ok: true, nextState: { expectedNext: null }, exhaustedAfterCommit: true });
    if (checked.ok) {
      expect(checkStrictExpectedNext(checked.nextState, max)).toEqual({ ok: false, reason: 'exhausted' });
    }
  });
});
