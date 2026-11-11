import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readDaemonState: vi.fn(),
  clearDaemonState: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readDaemonState: mocks.readDaemonState,
  clearDaemonState: mocks.clearDaemonState,
}));

import { checkIfDaemonRunningAndCleanupStaleState, daemonProbeFailure, listDaemonSessions, ownerRestartReplyFrom, resumeDaemonSession, setTerminalTitleViaDaemon, spawnDaemonSession } from './controlClient';

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

  it('setTerminalTitleViaDaemon posts /terminal-title and maps 200 / 409 / no-daemon to ok|error', async () => {
    mocks.readDaemonState.mockResolvedValue({ ...baseState, controlToken: 'state-secret' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Failed to set terminal title (tmux unavailable or terminal gone)' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(setTerminalTitleViaDaemon('term_1', 'pi: fix tests')).resolves.toEqual({ ok: true, error: undefined });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/terminal-title');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({ terminalId: 'term_1', title: 'pi: fix tests', ifAbsent: false });

    const refused = await setTerminalTitleViaDaemon('term_1', 'again', true);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('Failed to set terminal title');

    mocks.readDaemonState.mockResolvedValue(null);
    const noDaemon = await setTerminalTitleViaDaemon('term_1', 'x');
    expect(noDaemon).toEqual({ ok: false, error: 'No daemon running, no state file found' });
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

  // B-501: `very-happy send --resume` → /resume-session. Never throws; an old
  // daemon (fastify 404 "Not Found") is named as such, and the daemon's own
  // `resume-precheck:*` error reaches the caller without the transport prefix.
  it('resumeDaemonSession maps success / precheck 500 / old-daemon 404 / no daemon', async () => {
    mocks.readDaemonState.mockResolvedValue({ ...baseState, controlToken: 'state-secret' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ success: true, sessionId: 'sess-1' }, 200))
      .mockResolvedValueOnce(json({ success: false, error: 'resume-precheck:not-tracked: Session sess-1 is not tracked by this daemon.' }, 500))
      .mockResolvedValueOnce(json({ message: 'Route POST:/resume-session not found', error: 'Not Found', statusCode: 404 }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resumeDaemonSession('sess-1', { model: 'claude-opus-5-5' })).resolves.toEqual({ success: true, sessionId: 'sess-1' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/resume-session');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({ sessionId: 'sess-1', model: 'claude-opus-5-5' });

    await expect(resumeDaemonSession('sess-1')).resolves.toEqual({ success: false, error: 'resume-precheck:not-tracked: Session sess-1 is not tracked by this daemon.' });

    const old = await resumeDaemonSession('sess-1');
    expect(old.success).toBe(false);
    expect(old.error).toMatch(/daemon too old to resume sessions .* upgrade very-happy-cli/);

    mocks.readDaemonState.mockResolvedValue(null);
    await expect(resumeDaemonSession('sess-1')).resolves.toEqual({ success: false, error: 'No daemon running, no state file found' });
  });
});

describe('B-864: a busy daemon is never treated as stale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.readDaemonState.mockReset();
    mocks.clearDaemonState.mockReset();
  });

  it('keeps the state (and lock) of a live daemon that is too busy to answer in 2s', async () => {
    // A real listener that accepts and never answers: the daemon's event loop
    // is busy. Deleting its state + lock here let `daemon start` run a second
    // daemon beside it.
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const busy = createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const port = (busy.address() as import('node:net').AddressInfo).port;
    try {
      mocks.readDaemonState.mockResolvedValue({ ...baseState, httpPort: port, controlToken: 't' });
      vi.spyOn(process, 'kill').mockImplementation(() => true);
      await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);
      expect(mocks.clearDaemonState).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  }, 10_000);

  it('still cleans up when nothing listens on the recorded port (PID reused by another process)', async () => {
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    mocks.readDaemonState.mockResolvedValue({ ...baseState, httpPort: port, controlToken: 't' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);
    expect(mocks.clearDaemonState).toHaveBeenCalledOnce();
  });

  it('classifies probe failures', () => {
    expect(daemonProbeFailure(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe('unresponsive');
    expect(daemonProbeFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }))).toBe('unresponsive');
    expect(daemonProbeFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('not-listening');
    expect(daemonProbeFailure(new TypeError('fetch failed'))).toBe('not-listening');
  });
});

// B-919 (found in the isolated e2e): a refusal from the daemon has its own `error` — it is not "daemon unreachable".
describe('ownerRestartReplyFrom (B-919)', () => {
    it('passes the daemon\'s answer through, refusals included', () => {
        expect(ownerRestartReplyFrom({ ok: false, code: 'busy', error: 'busy:background-tasks' })).toEqual({ ok: false, code: 'busy', error: 'busy:background-tasks' });
        expect(ownerRestartReplyFrom({ ok: true, state: 'queued', targetVersion: '1.0.0' })).toEqual({ ok: true, state: 'queued', targetVersion: '1.0.0' });
    });
    it('maps daemonPost transport failures', () => {
        expect(ownerRestartReplyFrom({ error: 'Request failed: /session-restart-owner, HTTP 404' })).toEqual({ ok: false, code: 'daemon-too-old' });
        expect(ownerRestartReplyFrom({ error: 'No daemon running, no state file found' })).toMatchObject({ ok: false, code: 'daemon-unreachable' });
        expect(ownerRestartReplyFrom(undefined)).toMatchObject({ ok: false, code: 'daemon-unreachable' });
    });
});
