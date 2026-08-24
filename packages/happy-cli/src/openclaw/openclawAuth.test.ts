import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  base64UrlDecode,
  buildDeviceAuthPayload,
  loadOrCreateDeviceIdentity,
  migrateLegacyOpenClawAuth,
  resetIdentityCache,
  signPayload,
  storeDeviceAuthToken,
} from './openclawAuth';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Configure SHA-512 for verification in tests (@noble/ed25519 v3)
ed.hashes.sha512 = (message: Uint8Array) => sha512(message);

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openclaw-auth-test-'));
}

describe('openclawAuth', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = makeTempDir();
    resetIdentityCache();
  });

  it('should generate and persist device identity', async () => {
    const identity1 = await loadOrCreateDeviceIdentity(homeDir);
    expect(identity1.deviceId).toBeTruthy();
    expect(identity1.publicKey).toBeTruthy();
    expect(identity1.privateKey).toBeTruthy();
    expect(identity1.deviceId.length).toBe(64); // SHA-256 hex

    // Second call should return same identity (cached)
    const identity2 = await loadOrCreateDeviceIdentity(homeDir);
    expect(identity2.deviceId).toBe(identity1.deviceId);

    // After clearing cache, should load from file
    resetIdentityCache();
    const identity3 = await loadOrCreateDeviceIdentity(homeDir);
    expect(identity3.deviceId).toBe(identity1.deviceId);
  });

  it.skipIf(process.platform === 'win32')('stores device private key and gateway token with private permissions', async () => {
    const previousUmask = process.umask(0o022);
    try {
      await loadOrCreateDeviceIdentity(homeDir);
      await storeDeviceAuthToken(homeDir, {
        token: 'gateway-secret',
        role: 'operator',
        scopes: ['operator.admin'],
      });

      expect(statSync(join(homeDir, 'openclaw')).mode & 0o777).toBe(0o700);
      expect(statSync(join(homeDir, 'openclaw', 'device-identity.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(homeDir, 'openclaw', 'device-auth-token.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(process.platform === 'win32')('securely migrates legacy auth into an isolated happy home', () => {
    const legacyHome = makeTempDir();
    const nextHome = makeTempDir();
    const legacyDir = join(legacyHome, 'openclaw');
    mkdirSync(legacyDir, { mode: 0o755 });
    const identityPath = join(legacyDir, 'device-identity.json');
    const tokenPath = join(legacyDir, 'device-auth-token.json');
    writeFileSync(identityPath, JSON.stringify({ version: 1, privateKey: 'secret' }), { mode: 0o644 });
    writeFileSync(tokenPath, JSON.stringify({ token: 'gateway-secret' }), { mode: 0o644 });
    // Make the intended legacy exposure deterministic even with a restrictive test umask.
    chmodSync(legacyDir, 0o755);
    chmodSync(identityPath, 0o644);
    chmodSync(tokenPath, 0o644);

    migrateLegacyOpenClawAuth(legacyHome, nextHome);

    expect(statSync(legacyDir).mode & 0o777).toBe(0o700);
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(nextHome, 'openclaw')).mode & 0o777).toBe(0o700);
    expect(statSync(join(nextHome, 'openclaw', 'device-identity.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(nextHome, 'openclaw', 'device-auth-token.json')).mode & 0o777).toBe(0o600);
  });

  it('should build correct v2 payload', () => {
    const payload = buildDeviceAuthPayload({
      deviceId: 'abc123',
      clientId: 'node-host',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin'],
      signedAtMs: 1700000000000,
      token: null,
      nonce: 'testnonce',
    });
    expect(payload).toBe('v2|abc123|node-host|backend|operator|operator.admin|1700000000000||testnonce');
  });

  it('should include token in v2 payload when provided', () => {
    const payload = buildDeviceAuthPayload({
      deviceId: 'abc123',
      clientId: 'node-host',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals'],
      signedAtMs: 1700000000000,
      token: 'mytoken',
      nonce: 'testnonce',
    });
    expect(payload).toBe('v2|abc123|node-host|backend|operator|operator.admin,operator.approvals|1700000000000|mytoken|testnonce');
  });

  it('should produce valid Ed25519 signatures', async () => {
    const identity = await loadOrCreateDeviceIdentity(homeDir);
    const testPayload = 'v2|test|node-host|backend|operator|operator.admin|1700000000000||nonce123';
    const signature = await signPayload(identity.privateKey, testPayload);

    expect(signature).toBeTruthy();
    expect(signature.length).toBeGreaterThan(0);

    // Verify signature is valid
    const sigBytes = base64UrlDecode(signature);
    const pubKeyBytes = base64UrlDecode(identity.publicKey);
    const msgBytes = new TextEncoder().encode(testPayload);
    const valid = await ed.verify(sigBytes, msgBytes, pubKeyBytes);
    expect(valid).toBe(true);
  });
});
