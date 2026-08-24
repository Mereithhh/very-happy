import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';

const paths = vi.hoisted(() => {
  const root = `/tmp/very-happy-e2ee-credentials-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    root,
    privateKeyFile: `${root}/credentials.json`,
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: paths.root,
    privateKeyFile: paths.privateKeyFile,
    settingsFile: `${paths.root}/settings.json`,
    daemonStateFile: `${paths.root}/daemon.json`,
    daemonLockFile: `${paths.root}/daemon.lock`,
    sessionsFile: `${paths.root}/sessions.json`,
    logsDir: `${paths.root}/logs`,
    isDaemonProcess: false,
    serverUrl: 'https://happy.example',
  },
}));

import { readCredentials, writeCredentialsE2ee } from './persistence';

afterEach(async () => {
  await rm(paths.root, { recursive: true, force: true });
});

describe('E2EE CLI credentials', () => {
  it('round-trips the device-bound context without an account root secret', async () => {
    await mkdir(paths.root, { recursive: true });
    await writeCredentialsE2ee({
      token: 'device-bound-token',
      accountId: 'account-1',
      deviceId: 'daemon-1',
      cryptoEpoch: 7,
      publicKey: Uint8Array.from({ length: 32 }, (_, index) => index),
      machineKey: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
    });

    const raw = JSON.parse(await readFile(paths.privateKeyFile, 'utf8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('secret');
    expect(await readCredentials()).toEqual({
      token: 'device-bound-token',
      authServerUrl: 'https://happy.example',
      encryption: {
        type: 'e2ee-v1',
        accountId: 'account-1',
        deviceId: 'daemon-1',
        cryptoEpoch: 7,
        e2eeProtocol: 'vh-e2ee-1',
        capability: 'e2ee:runner',
        publicKey: Uint8Array.from({ length: 32 }, (_, index) => index),
        machineKey: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      },
    });
  });

  it('rejects malformed key sizes before writing', async () => {
    await expect(writeCredentialsE2ee({
      token: 'token',
      accountId: 'account-1',
      deviceId: 'daemon-1',
      cryptoEpoch: 1,
      publicKey: new Uint8Array(31),
      machineKey: new Uint8Array(32),
    })).rejects.toThrow('exactly 32 bytes');
  });
});
