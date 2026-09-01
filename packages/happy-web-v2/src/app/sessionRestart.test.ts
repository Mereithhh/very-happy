import { describe, expect, it } from 'vitest';
import {
  advanceRestartState,
  mapRestartError,
  restartEligibility,
  RESTART_AWAIT_ONLINE_TIMEOUT_MS,
  RESTART_ONLINE_GRACE_MS,
  type RestartState,
} from './sessionRestartRules';

const machines = { m1: { id: 'm1', active: true }, m2: { id: 'm2', active: false } };
// A LIVE (not archived) session whose process just failed to start.
const base = { active: true, archivedAt: null, metadata: { machineId: 'm1', flavor: 'claude', claudeSessionId: 'c1' } as any };

describe('B-264 restartEligibility', () => {
  it('accepts a live session whose machine is online — archived state is irrelevant here', () => {
    expect(restartEligibility(base, machines)).toEqual({ ok: true, machineId: 'm1' });
    // unlike restore, a broken live session is restartable regardless of archivedAt
    expect(restartEligibility({ ...base, archivedAt: 1000 }, machines)).toEqual({ ok: true, machineId: 'm1' });
  });
  it('rejects unknown machines and offline machines', () => {
    expect(restartEligibility({ ...base, metadata: { ...base.metadata, machineId: undefined } }, machines)).toEqual({ ok: false, reason: 'no-machine' });
    expect(restartEligibility({ ...base, metadata: { ...base.metadata, machineId: 'zz' } }, machines)).toEqual({ ok: false, reason: 'no-machine' });
    expect(restartEligibility({ ...base, metadata: { ...base.metadata, machineId: 'm2' } }, machines)).toEqual({ ok: false, reason: 'machine-offline' });
  });
});

describe('B-264 mapRestartError', () => {
  it('maps an old daemon "Method not found" to the distinct daemon-too-old reason', () => {
    expect(mapRestartError('Method not found')).toBe('daemon-too-old');
    expect(mapRestartError('RPC failed: method not found for restart-session')).toBe('daemon-too-old');
  });
  it('anything else is unknown', () => {
    expect(mapRestartError('Restart session handler not available')).toBe('unknown');
    expect(mapRestartError('Session s is missing its Claude session ID.')).toBe('unknown');
    expect(mapRestartError('')).toBe('unknown');
    expect(mapRestartError(undefined)).toBe('unknown');
  });
});

describe('B-264 advanceRestartState (await presence online — reused from restore)', () => {
  const st: RestartState = { phase: 'awaiting-online', startedAt: 0 };
  it('completes only after presence has been online for the grace window', () => {
    const a = advanceRestartState(st, { presence: 'online' }, 100)!;
    expect(a.onlineSince).toBe(100);
    expect(advanceRestartState(a, { presence: 'online' }, 100 + RESTART_ONLINE_GRACE_MS - 1)).toBe(a);
    expect(advanceRestartState(a, { presence: 'online' }, 100 + RESTART_ONLINE_GRACE_MS)).toBeNull();
  });
  it('times out when presence never arrives; other phases are untouched', () => {
    expect(advanceRestartState(st, { presence: 5 } as any, RESTART_AWAIT_ONLINE_TIMEOUT_MS)).toMatchObject({ phase: 'failed', reason: 'timeout' });
    const spawning: RestartState = { phase: 'spawning', startedAt: 0 };
    expect(advanceRestartState(spawning, { presence: 'online' }, 99_999)).toBe(spawning);
  });
});
