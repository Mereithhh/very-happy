import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => {
  const root = `/tmp/very-happy-daemon-state-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    root,
    daemonStateFile: `${root}/daemon.state.json`,
    daemonLockFile: `${root}/daemon.state.json.lock`,
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: paths.root,
    privateKeyFile: `${paths.root}/credentials.json`,
    settingsFile: `${paths.root}/settings.json`,
    daemonStateFile: paths.daemonStateFile,
    daemonLockFile: paths.daemonLockFile,
    sessionsFile: `${paths.root}/sessions.json`,
    logsDir: `${paths.root}/logs`,
    serverUrl: 'https://server.example',
  },
}));

import { readDaemonState, writeDaemonState } from '@/persistence';

afterEach(async () => {
  await rm(paths.root, { recursive: true, force: true });
});

describe('daemon state control credential', () => {
  it('round-trips the token in a mode-private file', async () => {
    await mkdir(paths.root, { recursive: true });
    writeDaemonState({
      pid: 123,
      httpPort: 456,
      controlToken: 'private-control-token',
      startTime: 'now',
      startedWithCliVersion: '1.2.3',
    });

    expect(JSON.parse(await readFile(paths.daemonStateFile, 'utf8'))).toHaveProperty(
      'controlToken',
      'private-control-token',
    );
    expect((await stat(paths.daemonStateFile)).mode & 0o777).toBe(0o600);
    expect((await readDaemonState())?.controlToken).toBe('private-control-token');
  });
});
