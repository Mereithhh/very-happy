import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('axios', () => ({ default: { get: getMock, post: postMock } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://cloud.example' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'web/test' }));

import {
  createGoogleLoginChallenge,
  loadPublicAuthConfig,
  loginWithGoogle,
  revokeCloudLogin,
} from './cloudAuth';

describe('cloud auth client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides optional cloud auth when config is unavailable', async () => {
    getMock.mockRejectedValueOnce(new Error('old server'));
    await expect(loadPublicAuthConfig()).resolves.toBeNull();
  });

  it('preserves the server E2EE rollout flags for auth routing', async () => {
    getMock.mockResolvedValueOnce({ data: {
      signup: {
        mode: 'open', maxAccounts: 100, registeredAccounts: 4,
        remainingAccounts: 96, atCapacity: false,
      },
      e2ee: { enabled: true, required: false },
    } });
    await expect(loadPublicAuthConfig()).resolves.toMatchObject({
      e2ee: { enabled: true, required: false },
    });
  });

  it('returns Google account credentials and forwards a non-empty invite', async () => {
    postMock.mockResolvedValueOnce({ data: { token: 'token', secret: 'secret' } });
    await expect(loginWithGoogle('id-token', 'signed-nonce', ' invite ')).resolves.toEqual({ token: 'token', secret: 'secret' });
    expect(postMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/account/login/google',
      { credential: 'id-token', nonce: 'signed-nonce', inviteCode: 'invite' },
      expect.any(Object),
    );
  });

  it('requests a one-time Google login challenge', async () => {
    postMock.mockResolvedValueOnce({ data: { nonce: 'fresh-nonce', expiresAt: '2026-08-24T00:05:00.000Z' } });
    await expect(createGoogleLoginChallenge()).resolves.toEqual({
      nonce: 'fresh-nonce',
      expiresAt: '2026-08-24T00:05:00.000Z',
    });
    expect(postMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/auth/google/challenge',
      {},
      expect.any(Object),
    );
  });

  it.each([
    [403, 'capacity-reached', 'capacity-reached'],
    [403, 'invite-required', 'invite-required'],
    [403, 'signup-closed', 'signup-closed'],
    [429, undefined, 'rate-limited'],
    [401, undefined, 'invalid-credential'],
  ])('maps server status %s/%s to %s', async (status, error, expected) => {
    postMock.mockRejectedValueOnce({ response: { status, data: { error } } });
    await expect(loginWithGoogle('bad-token', 'nonce')).rejects.toMatchObject({ code: expected });
  });

  it('reports a rejected browser origin while creating a Google challenge', async () => {
    postMock.mockRejectedValueOnce({ response: { status: 403, data: { error: 'origin_not_allowed' } } });
    await expect(createGoogleLoginChallenge()).rejects.toMatchObject({ code: 'origin-not-allowed' });
  });

  it('keeps local logout usable against an old or offline server', async () => {
    postMock.mockRejectedValueOnce(new Error('offline'));
    await expect(revokeCloudLogin({ token: 'token', secret: 'secret' })).resolves.toBeUndefined();
  });
});
