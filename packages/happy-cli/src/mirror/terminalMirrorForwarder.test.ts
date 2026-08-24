import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function runForwarder(controlToken?: string): Promise<string | undefined> {
  const home = await mkdtemp(join(tmpdir(), 'very-happy-forwarder-'));
  temporaryHomes.push(home);

  let finishRequest!: (authorization: string | undefined) => void;
  const requestReceived = new Promise<string | undefined>((resolveRequest) => {
    finishRequest = resolveRequest;
  });
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200).end('{}');
      finishRequest(request.headers.authorization);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('forwarder test server did not bind');

  await writeFile(join(home, 'daemon.state.json'), JSON.stringify({
    pid: process.pid,
    httpPort: address.port,
    ...(controlToken ? { controlToken } : {}),
  }));

  const childEnv = { ...process.env };
  delete childEnv.HAPPY_MANAGED;
  const child = spawn(process.execPath, [resolve(process.cwd(), 'scripts/terminal_mirror_forwarder.cjs')], {
    env: {
      ...childEnv,
      VH_TERMINAL_ID: 'terminal-test',
      VH_HAPPY_HOME_DIR: home,
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart' }));

  try {
    return await requestReceived;
  } finally {
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once('exit', () => resolveExit());
    });
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

describe('terminal mirror hook forwarder authentication', () => {
  it('sends the daemon state bearer token', async () => {
    await expect(runForwarder('forwarder-state-secret')).resolves.toBe('Bearer forwarder-state-secret');
  });

  it('omits the header for an old daemon state without a token', async () => {
    await expect(runForwarder()).resolves.toBeUndefined();
  });
});
