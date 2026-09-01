import { describe, expect, it } from 'vitest';
import {
  advanceRestoreState,
  composerGate,
  isRestorable,
  mapResumeError,
  restoreEligibility,
  RESTORE_AWAIT_ONLINE_TIMEOUT_MS,
  RESTORE_ONLINE_GRACE_MS,
  type RestoreState,
} from './sessionRestoreRules';
import { canReleaseQueuedMessage } from '@/screens/session/queuedMessages';

const machines = { m1: { id: 'm1', active: true }, m2: { id: 'm2', active: false } };
const base = { active: false, archivedAt: 1000, metadata: { machineId: 'm1', flavor: 'claude', claudeSessionId: 'c1' } as any };

describe('B-265 restoreEligibility', () => {
  it('accepts an archived claude session whose machine is online', () => {
    expect(restoreEligibility(base, machines)).toEqual({ ok: true, machineId: 'm1' });
  });
  it('an inactive session WITHOUT archivedAt is merely offline — never restorable (its process reconnects on its own)', () => {
    expect(restoreEligibility({ ...base, archivedAt: null }, machines)).toEqual({ ok: false, reason: 'not-archived' });
    expect(restoreEligibility({ ...base, archivedAt: undefined }, machines)).toEqual({ ok: false, reason: 'not-archived' });
    expect(isRestorable({ ...base, archivedAt: null })).toBe(false);
    expect(isRestorable(base)).toBe(true);
    expect(isRestorable({ ...base, active: true })).toBe(false);
  });
  it('rejects unsupported flavors, missing backend ids, unknown / offline machines', () => {
    expect(restoreEligibility({ ...base, metadata: { ...base.metadata, flavor: 'gemini' } }, machines)).toEqual({ ok: false, reason: 'unsupported-flavor' });
    expect(restoreEligibility({ ...base, metadata: { ...base.metadata, claudeSessionId: undefined } }, machines)).toEqual({ ok: false, reason: 'no-backend-id' });
    expect(restoreEligibility({ ...base, metadata: { machineId: 'm1', flavor: 'codex' } as any }, machines)).toEqual({ ok: false, reason: 'no-backend-id' });
    expect(restoreEligibility({ ...base, metadata: { machineId: 'm1', flavor: 'codex', codexThreadId: 't' } as any }, machines)).toEqual({ ok: true, machineId: 'm1' });
    expect(restoreEligibility({ ...base, metadata: { ...base.metadata, machineId: undefined } }, machines)).toEqual({ ok: false, reason: 'no-machine' });
    expect(restoreEligibility({ ...base, metadata: { ...base.metadata, machineId: 'zz' } }, machines)).toEqual({ ok: false, reason: 'no-machine' });
    expect(restoreEligibility({ ...base, metadata: { ...base.metadata, machineId: 'm2' } }, machines)).toEqual({ ok: false, reason: 'machine-offline' });
  });
});

describe('B-265 mapResumeError', () => {
  it('maps the new prefixed precheck codes', () => {
    expect(mapResumeError('resume-precheck:not-tracked: x')).toBe('not-tracked');
    expect(mapResumeError('resume-precheck:no-encryption')).toBe('not-tracked');
    expect(mapResumeError('resume-precheck:no-backend-id')).toBe('no-backend-id');
    expect(mapResumeError('resume-precheck:unsupported-flavor')).toBe('unsupported-flavor');
    expect(mapResumeError('resume-precheck:missing-cwd')).toBe('missing-cwd');
    expect(mapResumeError('resume-precheck:conversation-missing')).toBe('conversation-missing');
    expect(mapResumeError('resume-precheck:whatever')).toBe('unknown');
  });
  it('maps old-CLI free text and transport failures', () => {
    expect(mapResumeError('Session s is not tracked by this daemon. It may have…')).toBe('not-tracked');
    expect(mapResumeError('Session s has no stored encryption data.')).toBe('not-tracked');
    expect(mapResumeError('Happy session s is missing its Claude session ID.')).toBe('no-backend-id');
    expect(mapResumeError('Happy session s uses unsupported flavor "gemini".')).toBe('unsupported-flavor');
    expect(mapResumeError('Failed to resume session: ENOENT: no such file')).toBe('missing-cwd');
    expect(mapResumeError('RPC method not available')).toBe('machine-unreachable');
    expect(mapResumeError('RPC target disconnected')).toBe('machine-unreachable');
    expect(mapResumeError('operation has timed out')).toBe('machine-unreachable');
    expect(mapResumeError('something else')).toBe('unknown');
    expect(mapResumeError(undefined)).toBe('unknown');
  });
});

describe('B-265 advanceRestoreState (await presence online)', () => {
  const st: RestoreState = { phase: 'awaiting-online', startedAt: 0 };
  it('completes only after presence has been online for the grace window', () => {
    const a = advanceRestoreState(st, { presence: 'online' }, 100)!;
    expect(a.onlineSince).toBe(100);
    expect(advanceRestoreState(a, { presence: 'online' }, 100 + RESTORE_ONLINE_GRACE_MS - 1)).toBe(a);
    expect(advanceRestoreState(a, { presence: 'online' }, 100 + RESTORE_ONLINE_GRACE_MS)).toBeNull();
  });
  it('an online blip resets the grace window', () => {
    const a = advanceRestoreState(st, { presence: 'online' }, 100)!;
    const b = advanceRestoreState(a, { presence: 500 }, 600)!;
    expect(b.onlineSince).toBeUndefined();
    expect(advanceRestoreState(b, { presence: 'online' }, 700)!.onlineSince).toBe(700);
  });
  it('times out when presence never arrives; other phases are untouched', () => {
    expect(advanceRestoreState(st, { presence: 5 }, RESTORE_AWAIT_ONLINE_TIMEOUT_MS - 1)).toBe(st);
    expect(advanceRestoreState(st, undefined, RESTORE_AWAIT_ONLINE_TIMEOUT_MS)).toMatchObject({ phase: 'failed', reason: 'timeout' });
    const spawning: RestoreState = { phase: 'spawning', startedAt: 0 };
    expect(advanceRestoreState(spawning, { presence: 'online' }, 99_999)).toBe(spawning);
  });
});

describe('B-265 composer gate', () => {
  it('only an archived session restores first; live and merely-offline sessions send as before', () => {
    expect(composerGate(base)).toBe('restore-first');
    expect(composerGate({ ...base, archivedAt: null })).toBe('send');
    expect(composerGate({ ...base, active: true, archivedAt: null })).toBe('send');
    expect(composerGate(null)).toBe('send');
  });
  it('the queue never releases into an archived session (regression: idle + not working used to send into the void)', () => {
    expect(canReleaseQueuedMessage('idle', false)).toBe(true);
    expect(canReleaseQueuedMessage('idle', false, 'send')).toBe(true);
    expect(canReleaseQueuedMessage('idle', false, 'restore-first')).toBe(false);
    expect(canReleaseQueuedMessage('waiting-start', false, 'send')).toBe(false);
  });
});
