import { describe, expect, it } from 'vitest';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { withDaemonHeartbeat } from './daemonState';

describe('daemon state heartbeat', () => {
  it('preserves the control credential while advancing the heartbeat', () => {
    const state: DaemonLocallyPersistedState = {
      pid: 123,
      httpPort: 456,
      controlToken: 'private-control-token',
      startTime: 'start',
      startedWithCliVersion: '1.2.3',
      serverUrl: 'https://server.example',
      webappUrl: 'https://web.example',
      daemonLogPath: '/private/log',
      cliUpdate: {
        currentVersion: '1.2.3',
        recommendedVersion: '1.2.4',
        minimumVersion: '1.0.0',
        status: 'available',
        checkedAt: 123,
      },
    };

    expect(withDaemonHeartbeat(state, 'heartbeat')).toEqual({
      ...state,
      lastHeartbeat: 'heartbeat',
    });
    expect(state.lastHeartbeat).toBeUndefined();
  });
});
