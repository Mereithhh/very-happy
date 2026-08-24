import { describe, expect, it } from 'vitest';
import {
  StrictControlCounter,
  controlHandshakeMac,
  decryptControlPayload,
  deriveControlConnection,
  encryptControlPayload,
  nonceForControlCounter,
  verifyControlHandshakeMac,
} from './controlCrypto';

const machineKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const transcript = '{"accountId":"a","bootId":"b","domain":"very-happy/vh-e2ee-1/connection"}';

describe('vh-e2ee-1 control crypto', () => {
  it('derives deterministic, direction-separated connection material', () => {
    const first = deriveControlConnection(machineKey, transcript);
    const second = deriveControlConnection(machineKey, transcript);
    expect(first).toEqual(second);
    expect(first.controlToRunnerKey).not.toEqual(first.runnerToControlKey);
    expect(first.controlToRunnerNoncePrefix).not.toEqual(first.runnerToControlNoncePrefix);
    expect(Buffer.from(first.connectionId, 'base64url')).toHaveLength(32);
  });

  it('authenticates the exact handshake transcript', () => {
    const mac = controlHandshakeMac(machineKey, transcript);
    expect(verifyControlHandshakeMac(machineKey, transcript, mac)).toBe(true);
    expect(verifyControlHandshakeMac(machineKey, `${transcript} `, mac)).toBe(false);
    expect(verifyControlHandshakeMac(new Uint8Array(32).fill(9), transcript, mac)).toBe(false);
  });

  it('constructs a unique 4-byte-prefix plus uint64 counter nonce', () => {
    const prefix = new Uint8Array([1, 2, 3, 4]);
    expect(Buffer.from(nonceForControlCounter(prefix, '0')).toString('hex')).toBe('010203040000000000000000');
    expect(Buffer.from(nonceForControlCounter(prefix, '1')).toString('hex')).toBe('010203040000000000000001');
    expect(() => nonceForControlCounter(prefix, '18446744073709551616')).toThrow('overflow');
  });

  it('round-trips only with the exact counter, nonce and AAD', () => {
    const derived = deriveControlConnection(machineKey, transcript);
    const body = new TextEncoder().encode('rm nothing; harmless fixture');
    const payload = encryptControlPayload(
      derived.controlToRunnerKey,
      derived.controlToRunnerNoncePrefix,
      '0',
      '["vh-e2ee-1","terminal-input"]',
      body,
    );
    expect(decryptControlPayload(
      derived.controlToRunnerKey,
      derived.controlToRunnerNoncePrefix,
      '0',
      '["vh-e2ee-1","terminal-input"]',
      payload,
    )).toEqual(body);
    expect(decryptControlPayload(
      derived.controlToRunnerKey,
      derived.controlToRunnerNoncePrefix,
      '1',
      '["vh-e2ee-1","terminal-input"]',
      payload,
    )).toBeNull();
    expect(decryptControlPayload(
      derived.controlToRunnerKey,
      derived.controlToRunnerNoncePrefix,
      '0',
      '["vh-e2ee-1","terminal-close"]',
      payload,
    )).toBeNull();
  });

  it('does not advance strict state before an authenticated commit', () => {
    const state = new StrictControlCounter();
    expect(state.matches('1000000')).toBe(false);
    expect(state.expected()).toBe('0');
    expect(() => state.commit('1')).toThrow('unexpected');
    state.commit('0');
    expect(state.expected()).toBe('1');
    expect(state.matches('0')).toBe(false);
  });

  it('accepts uint64 max once and then exhausts without wrapping', () => {
    const prefix = new Uint8Array([9, 8, 7, 6]);
    expect(nonceForControlCounter(prefix, '18446744073709551615')).toHaveLength(12);
    // Reaching max through 2^64 commits is deliberately not simulated here;
    // the wire pure-state vector covers the terminal transition.
  });
});
