import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TERMINAL_FACE_NAVIGATION_OPTIONS,
  resolveTerminalView,
  resolveTerminalOpenPath,
  isTerminalViewRedirectWindowOpen,
  withTerminalViewOverride,
  pruneTerminalViewOverrides,
} from './terminalViewPref';

describe('terminal face navigation', () => {
  it('replaces history because xterm and structured mirror are one navigation level', () => {
    expect(TERMINAL_FACE_NAVIGATION_OPTIONS).toEqual({ replace: true });
  });

  it('is used by both explicit xterm ↔ structured switches', () => {
    const terminal = readFileSync(
      new URL('../screens/terminal/WebTerminalScreen.tsx', import.meta.url),
      'utf8',
    );
    const mirror = readFileSync(
      new URL('../screens/session/MirrorBanner.tsx', import.meta.url),
      'utf8',
    );
    expect(terminal).toContain('navigate(`/session/${mirrorSessionId}`, TERMINAL_FACE_NAVIGATION_OPTIONS)');
    expect(mirror).toContain('navigate(`/terminal/${machineId}?tid=${terminalId}`, TERMINAL_FACE_NAVIGATION_OPTIONS)');
  });
});

describe('resolveTerminalOpenPath', () => {
  const base = { machineId: 'm/1', terminalId: 't 1', mirrorSessionId: 's/1' };

  it('opens a known mirror directly when structured is preferred', () => {
    expect(resolveTerminalOpenPath({ ...base, defaultView: 'structured', overrides: {} }))
      .toBe('/session/s%2F1');
  });

  it('keeps xterm when explicitly overridden, even with a mirror', () => {
    expect(resolveTerminalOpenPath({ ...base, defaultView: 'structured', overrides: { 't 1': 'xterm' } }))
      .toBe('/terminal/m%2F1?tid=t%201');
  });

  it('keeps xterm when the mirror has not arrived yet', () => {
    expect(resolveTerminalOpenPath({ ...base, mirrorSessionId: undefined, defaultView: 'structured' }))
      .toBe('/terminal/m%2F1?tid=t%201');
  });
});

describe('isTerminalViewRedirectWindowOpen', () => {
  it('allows the initial hydration window, including its boundary', () => {
    expect(isTerminalViewRedirectWindowOpen(10_000, 10_000)).toBe(true);
    expect(isTerminalViewRedirectWindowOpen(10_000, 13_000)).toBe(true);
  });

  it('refuses a late mirror so active terminal input is never hijacked', () => {
    expect(isTerminalViewRedirectWindowOpen(10_000, 13_001)).toBe(false);
    expect(isTerminalViewRedirectWindowOpen(10_000, 60_000)).toBe(false);
  });
});

describe('resolveTerminalView', () => {
  it('falls back to xterm when nothing is set', () => {
    expect(resolveTerminalView(undefined, undefined, undefined)).toBe('xterm');
    expect(resolveTerminalView(undefined, {}, 't1')).toBe('xterm');
  });

  it('uses the device default when no override exists', () => {
    expect(resolveTerminalView('structured', {}, 't1')).toBe('structured');
    expect(resolveTerminalView('xterm', {}, 't1')).toBe('xterm');
  });

  it('per-terminal override beats the device default (both directions)', () => {
    expect(resolveTerminalView('xterm', { t1: 'structured' }, 't1')).toBe('structured');
    expect(resolveTerminalView('structured', { t1: 'xterm' }, 't1')).toBe('xterm');
    // other terminals keep the default
    expect(resolveTerminalView('structured', { t1: 'xterm' }, 't2')).toBe('structured');
  });

  it('junk stored values never escape: invalid override falls through, invalid default → xterm', () => {
    expect(resolveTerminalView('structured', { t1: 'banana' }, 't1')).toBe('structured');
    expect(resolveTerminalView('banana', { t1: 'banana' }, 't1')).toBe('xterm');
    expect(resolveTerminalView(42, {}, 't1')).toBe('xterm');
  });
});

describe('withTerminalViewOverride', () => {
  it('stores the explicit choice even when it equals the default semantics', () => {
    const next = withTerminalViewOverride({}, 't1', 'xterm');
    expect(next).toEqual({ t1: 'xterm' });
  });

  it('returns the SAME object when the value is already stored (cheap-compare)', () => {
    const cur = { t1: 'structured' };
    expect(withTerminalViewOverride(cur, 't1', 'structured')).toBe(cur);
  });

  it('does not mutate the input', () => {
    const cur = { t1: 'xterm' };
    const next = withTerminalViewOverride(cur, 't1', 'structured');
    expect(cur).toEqual({ t1: 'xterm' });
    expect(next).toEqual({ t1: 'structured' });
  });
});

describe('pruneTerminalViewOverrides', () => {
  it('drops overrides whose terminal has a closed record', () => {
    const next = pruneTerminalViewOverrides(
      { t1: 'structured', t2: 'xterm' },
      new Set(['t1']),
    );
    expect(next).toEqual({ t2: 'xterm' });
  });

  it('keeps overrides for terminals with no closed record (independent machine pushes)', () => {
    const cur = { t1: 'structured' };
    expect(pruneTerminalViewOverrides(cur, new Set(['other']))).toBe(cur);
    expect(pruneTerminalViewOverrides(cur, new Set())).toBe(cur);
  });
});
