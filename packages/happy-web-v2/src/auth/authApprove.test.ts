import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://relay.example' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'web/test' }));

import { authApprove } from './authApprove';

describe('authApprove', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a missing request instead of reporting a false success', async () => {
    axiosMock.get.mockResolvedValue({ data: { status: 'not_found', supportsV2: false } });
    await expect(authApprove('token', new Uint8Array(32), new Uint8Array([1]), new Uint8Array([2])))
      .rejects.toThrow('not found');
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('posts the v2 answer for a pending v2 request', async () => {
    axiosMock.get.mockResolvedValue({ data: { status: 'pending', supportsV2: true } });
    axiosMock.post.mockResolvedValue({ data: { success: true } });
    await authApprove('token', new Uint8Array(32), new Uint8Array([1]), new Uint8Array([2]));
    expect(axiosMock.post).toHaveBeenCalledOnce();
    expect(axiosMock.post.mock.calls[0]?.[1]).toMatchObject({ response: 'Ag==' });
  });

  it('treats an already authorized request as idempotent', async () => {
    axiosMock.get.mockResolvedValue({ data: { status: 'authorized', supportsV2: false } });
    await authApprove('token', new Uint8Array(32), new Uint8Array([1]), new Uint8Array([2]));
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});
