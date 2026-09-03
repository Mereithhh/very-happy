import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readDaemonState: vi.fn(),
  clearDaemonState: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readDaemonState: mocks.readDaemonState,
  clearDaemonState: mocks.clearDaemonState,
}));

import { checkIfDaemonRunningAndCleanupStaleState, listDaemonSessions, spawnDaemonSession } from './controlClient';

const baseState = {
  pid: 4242,
  httpPort: 9999,
  startTime: 'now',
  startedWithCliVersion: '1.0.0',
};

describe('daemon control client authentication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.readDaemonState.mockReset();
  });

  it('sends the state bearer token to a new daemon', async () => {
    mocks.readDaemonState.mockResolvedValue({ ...baseState, controlToken: 'state-secret' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ children: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDaemonSessions()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer state-secret',
    });
  });

  it("surfaces the daemon's error body on a non-2xx reply (spawn --agent pi install hint)", async () => {
    mocks.readDaemonState.mockResolvedValue({ ...baseState, controlToken: 'state-secret' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const hint = 'very-happy pi needs the pi-acp adapter on PATH: npm install -g pi-acp@0.0.33';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: hint }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })));

    const result = await spawnDaemonSession('/tmp/x', undefined, { agent: 'pi' });
    expect(result.error).toContain(hint);
  });

  it('falls back to the status code when a non-2xx reply has no error body', async () => {
    mocks.readDaemonState.mockResolvedValue({ ...baseState, controlToken: 'state-secret' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));

    await expect(listDaemonSessions()).resolves.toEqual([]);
  });

  it('omits authorization for an old daemon state without a token', async () => {
    mocks.readDaemonState.mockResolvedValue(baseState);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ children: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDaemonSessions()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('authenticates the HTTP readiness probe as well as ordinary posts', async () => {
    mocks.readDaemonState.mockResolvedValue({ ...baseState, controlToken: 'probe-secret' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer probe-secret',
    });
  });
});
