import { describe, it, expect } from 'vitest';
import {
  WRAPPER_DELIVERY_FIX_VERSION,
  isStaleWrapperNoticeVisible,
  machineCliVersion,
  staleWrapperHintKey,
  staleWrapperNotice,
  type StaleWrapperMachineLike,
  type StaleWrapperSessionLike,
} from './staleWrapperPolicy';

const machine = (version: string | null, extra: Partial<StaleWrapperMachineLike> = {}): StaleWrapperMachineLike => ({
  active: true,
  daemonState: version === null ? {} : { startedWithCliVersion: version },
  ...extra,
});

const session = (version: string | undefined, extra: Partial<StaleWrapperSessionLike> = {}): StaleWrapperSessionLike => ({
  archivedAt: null,
  metadata: { machineId: 'm1', version },
  ...extra,
});

describe('machineCliVersion', () => {
  it('prefers the version the daemon process is actually running', () => {
    expect(machineCliVersion({
      daemonState: { startedWithCliVersion: '0.2.141', cliUpdate: { currentVersion: '0.2.130' } },
      metadata: { happyCliVersion: '0.2.99' },
    })).toBe('0.2.141');
  });

  it('falls back for daemons too old to report it, and gives up on nothing usable', () => {
    expect(machineCliVersion({ daemonState: { cliUpdate: { currentVersion: '0.2.130' } } })).toBe('0.2.130');
    expect(machineCliVersion({ metadata: { happyCliVersion: '0.2.99' } })).toBe('0.2.99');
    expect(machineCliVersion({ daemonState: { startedWithCliVersion: '  ' } })).toBeNull();
    expect(machineCliVersion({ daemonState: { startedWithCliVersion: 141 } })).toBeNull();
    expect(machineCliVersion(null)).toBeNull();
  });
});

describe('staleWrapperNotice', () => {
  it('reports a live session whose wrapper lags the installed daemon', () => {
    expect(staleWrapperNotice(session('0.2.140'), machine('0.2.141'))).toEqual({
      sessionVersion: '0.2.140',
      machineVersion: '0.2.141',
      severity: 'behind',
    });
  });

  it('calls a wrapper below the message-delivery fix critical', () => {
    // B-460: these are the wrappers that can swallow a sent message outright.
    expect(staleWrapperNotice(session('0.2.104'), machine('0.2.141'))?.severity).toBe('critical');
    expect(staleWrapperNotice(session('0.2.136'), machine('0.2.141'))?.severity).toBe('critical');
    expect(staleWrapperNotice(session(WRAPPER_DELIVERY_FIX_VERSION), machine('0.2.141'))?.severity).toBe('behind');
  });

  it('says nothing when the wrapper is current or ahead', () => {
    expect(staleWrapperNotice(session('0.2.141'), machine('0.2.141'))).toBeNull();
    expect(staleWrapperNotice(session('0.2.142'), machine('0.2.141'))).toBeNull();
  });

  it('stays silent where a restart is not the answer', () => {
    // archived → the restore banner owns this session
    expect(staleWrapperNotice(session('0.2.104', { archivedAt: 1 }), machine('0.2.141'))).toBeNull();
    // terminal mirror → no wrapper of its own to restart
    expect(staleWrapperNotice({ archivedAt: null, metadata: { version: '0.2.104', flavor: 'terminal-mirror' } }, machine('0.2.141'))).toBeNull();
    // offline machine → restart-session would fail anyway
    expect(staleWrapperNotice(session('0.2.104'), machine('0.2.141', { active: false }))).toBeNull();
  });

  it('never guesses from a version it cannot read', () => {
    expect(staleWrapperNotice(session(undefined), machine('0.2.141'))).toBeNull();
    expect(staleWrapperNotice(session('dev'), machine('0.2.141'))).toBeNull();
    expect(staleWrapperNotice(session('0.2.104'), machine(null))).toBeNull();
    expect(staleWrapperNotice(null, machine('0.2.141'))).toBeNull();
  });
});

describe('dismissal', () => {
  it('is remembered per session and wrapper version', () => {
    const notice = staleWrapperNotice(session('0.2.104'), machine('0.2.141'))!;
    const key = staleWrapperHintKey('s1', notice);
    expect(key).toBe('stale-wrapper:s1:0.2.104');
    expect(isStaleWrapperNoticeVisible(key, {})).toBe(true);
    expect(isStaleWrapperNoticeVisible(key, { [key]: Date.now() })).toBe(false);
    expect(isStaleWrapperNoticeVisible(key, undefined)).toBe(true);
    // a different session, or the same session after a restart onto a newer
    // wrapper that later falls behind again, is a fresh notice
    expect(isStaleWrapperNoticeVisible(staleWrapperHintKey('s2', notice), { [key]: Date.now() })).toBe(true);
    expect(isStaleWrapperNoticeVisible(staleWrapperHintKey('s1', { sessionVersion: '0.2.141' }), { [key]: Date.now() })).toBe(true);
  });
});
