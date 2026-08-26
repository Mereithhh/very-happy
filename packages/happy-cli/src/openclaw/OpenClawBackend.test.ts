import { describe, expect, it, vi } from 'vitest';
import { OpenClawBackend } from './OpenClawBackend';

describe('OpenClawBackend usage snapshot', () => {
  it('selects the active gateway session cumulative usage', async () => {
    // Construct without opening a socket; this test intentionally replaces
    // private runtime collaborators with a minimal fixture.
    const backend = Object.create(OpenClawBackend.prototype) as any;
    backend.sessionKey = 'agent:main:main';
    backend.socket = {
      isConnected: () => true,
      listSessions: vi.fn(async () => [
        { key: 'other', kind: 'direct' as const, updatedAt: 1, totalTokens: 5 },
        { key: 'agent:main:main', kind: 'direct' as const, updatedAt: 2, inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      ]),
    };

    await expect(backend.getUsageSnapshot()).resolves.toMatchObject({
      key: 'agent:main:main',
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    expect(backend.socket.listSessions).toHaveBeenCalledWith(100);
  });
});
