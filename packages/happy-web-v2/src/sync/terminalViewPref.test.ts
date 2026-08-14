import { describe, it, expect } from 'vitest';
import {
  resolveTerminalView,
  withTerminalViewOverride,
  pruneTerminalViewOverrides,
} from './terminalViewPref';

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
