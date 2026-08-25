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
  loginWithEmail,
  loadPublicAuthConfig,
  loadAccountLoginMethods,
  linkEmailIdentity,
  linkGoogleIdentity,
  loginWithGoogle,
  requestEmailLoginCode,
  refreshCloudLogin,
  revokeCloudLogin,
} from './cloudAuth';

describe('cloud auth client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides optional cloud auth when config is unavailable', async () => {
    getMock.mockRejectedValueOnce(new Error('old server'));
    await expect(loadPublicAuthConfig()).resolves.toBeNull();
  });

  it('normalizes old server config to password-compatible defaults', async () => {
    getMock.mockResolvedValueOnce({ data: { signup: { mode: 'closed', maxAccounts: null, registeredAccounts: 1, remainingAccounts: null, atCapacity: false } } });
    await expect(loadPublicAuthConfig()).resolves.toMatchObject({ emailOtpEnabled: false, passwordLoginEnabled: true });
  });

  it('requests and verifies a normalized Email OTP without inventing an account mode', async () => {
    postMock
      .mockResolvedValueOnce({ data: { challengeId: 'challenge', expiresAt: '2030-01-01T00:10:00.000Z' } })
      .mockResolvedValueOnce({ data: { token: 'token', secret: 'secret' } });
    await expect(requestEmailLoginCode(' Person@Example.com ')).resolves.toMatchObject({ challengeId: 'challenge' });
    await expect(loginWithEmail(' Person@Example.com ', 'challenge', '123456', ' invite '))
      .resolves.toEqual({ token: 'token', secret: 'secret' });
    expect(postMock.mock.calls[0][1]).toEqual({ email: 'person@example.com' });
    expect(postMock.mock.calls[1][1]).toEqual({
      email: 'person@example.com', challengeId: 'challenge', code: '123456', inviteCode: 'invite',
    });
  });

  it('loads current login methods and links Email with the authenticated account secret', async () => {
    const credentials = { token: 'current-token', secret: 'account-secret' };
    getMock.mockResolvedValueOnce({
      data: { email: null, google: { connected: true, email: 'owner@example.com' }, passwordConfigured: true },
    });
    postMock.mockResolvedValueOnce({ data: { success: true, email: 'owner@example.com' } });

    await expect(loadAccountLoginMethods(credentials)).resolves.toMatchObject({
      google: { connected: true }, passwordConfigured: true,
    });
    await expect(linkEmailIdentity(' Owner@Example.com ', 'challenge', '123456', credentials))
      .resolves.toEqual({ success: true, email: 'owner@example.com' });
    expect(getMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/account/identities',
      { headers: expect.objectContaining({ Authorization: 'Bearer current-token' }) },
    );
    expect(postMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/account/identities/email',
      {
        email: 'owner@example.com', challengeId: 'challenge', code: '123456', secret: 'account-secret',
      },
      { headers: expect.objectContaining({ Authorization: 'Bearer current-token' }) },
    );
  });

  it('refreshes a cloud login with both the active bearer and account secret', async () => {
    const credentials = { token: 'current-token', secret: 'account-secret' };
    postMock.mockResolvedValueOnce({ data: { token: 'fresh-token', secret: 'account-secret' } });

    await expect(refreshCloudLogin(credentials)).resolves.toEqual({
      token: 'fresh-token', secret: 'account-secret',
    });
    expect(postMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/account/login/refresh',
      { secret: 'account-secret' },
      { headers: expect.objectContaining({ Authorization: 'Bearer current-token' }) },
    );
  });

  it.each([
    [409, 'email_identity_in_use', 'email-identity-in-use'],
    [403, 'reauth_required', 'reauth-required'],
    [401, 'invalid_email_code', 'invalid-email-code'],
    [429, 'too_many_requests', 'rate-limited'],
  ])('maps Email identity link failure %s/%s', async (status, error, expected) => {
    postMock.mockRejectedValueOnce({ response: { status, data: { error } } });
    await expect(linkEmailIdentity('owner@example.com', 'challenge', '000000', { token: 't', secret: 's' }))
      .rejects.toMatchObject({ code: expected });
  });

  it('links Google with the authenticated account secret', async () => {
    const credentials = { token: 'current-token', secret: 'account-secret' };
    postMock.mockResolvedValueOnce({ data: { success: true, email: 'owner@example.com' } });
    await expect(linkGoogleIdentity('id-token', 'signed-nonce', credentials))
      .resolves.toEqual({ success: true, email: 'owner@example.com' });
    expect(postMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/account/identities/google',
      { credential: 'id-token', nonce: 'signed-nonce', secret: 'account-secret' },
      { headers: expect.objectContaining({ Authorization: 'Bearer current-token' }) },
    );
  });

  it.each([
    [409, 'google_identity_in_use', 'google-identity-in-use'],
    [403, 'reauth_required', 'reauth-required'],
    [403, 'origin_not_allowed', 'origin-not-allowed'],
    [400, 'invalid_secret', 'invalid-account-secret'],
    [401, 'invalid_google_credential', 'invalid-credential'],
    [501, 'google_not_configured', 'google-not-configured'],
    [429, 'too_many_requests', 'rate-limited'],
  ])('maps Google identity link failure %s/%s', async (status, error, expected) => {
    postMock.mockRejectedValueOnce({ response: { status, data: { error } } });
    await expect(linkGoogleIdentity('bad-token', 'nonce', { token: 't', secret: 's' }))
      .rejects.toMatchObject({ code: expected });
  });

  it.each([
    [503, 'email_delivery_unavailable', 'email-delivery-unavailable'],
    [501, 'email_not_configured', 'email-not-configured'],
    [429, 'too_many_requests', 'rate-limited'],
  ])('maps Email code request failure %s/%s', async (status, error, expected) => {
    postMock.mockRejectedValueOnce({ response: { status, data: { error } } });
    await expect(requestEmailLoginCode('person@example.com')).rejects.toMatchObject({ code: expected });
  });

  it.each([
    [401, 'invalid_email_code', 'invalid-email-code'],
    [403, 'capacity-reached', 'capacity-reached'],
    [403, 'invite-required', 'invite-required'],
    [403, 'signup-closed', 'signup-closed'],
  ])('maps Email verification failure %s/%s', async (status, error, expected) => {
    postMock.mockRejectedValueOnce({ response: { status, data: { error } } });
    await expect(loginWithEmail('person@example.com', 'challenge', '000000')).rejects.toMatchObject({ code: expected });
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
