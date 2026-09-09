import { expect, it, vi } from 'vitest';
import { MachineEncryption } from './machineEncryption';
import { EncryptionCache } from './encryptionCache';

const metadata = {
  host: 'isolated-review', platform: 'darwin', happyCliVersion: '0.0.0-test',
  homeDir: '/review', happyHomeDir: '/review/.happy', teamsVersion: 1,
};

it.each([undefined, 1, 2])('retains reported team launch version %s through parsing and cache', async (version) => {
  const reported = { ...metadata, ...(version === undefined ? {} : { teamLaunchVersion: version }) };
  const decrypt = vi.fn(async () => [reported]);
  const encryption = new MachineEncryption('review', {
    encrypt: async () => [new Uint8Array()], decrypt,
  }, new EncryptionCache());
  const parsed = await encryption.decryptMetadata(1, 'AA==');
  expect(parsed).toEqual(reported);
  expect(await encryption.decryptMetadata(1, 'AA==')).toBe(parsed);
  expect(decrypt).toHaveBeenCalledTimes(1);
});
