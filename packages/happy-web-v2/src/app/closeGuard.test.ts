import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchCloseViewChord,
  isClosableViewPath,
  closeViewTarget,
  closeViewAction,
  shouldWarnOnUnload,
  pickRefocusTarget,
} from './closeGuard';
import {
  markProgrammaticReload,
  isProgrammaticReloadPending,
  resetProgrammaticReload,
  PROGRAMMATIC_RELOAD_WINDOW_MS,
} from './programmaticReload';

function ev(over: Partial<Parameters<typeof matchCloseViewChord>[0]> = {}) {
  return {
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    key: '', code: '', target: null,
    ...over,
  };
}

describe('matchCloseViewChord', () => {
  it('matches ⌘W and ⌥W (by code — macOS ⌥W types ∑)', () => {
    expect(matchCloseViewChord(ev({ metaKey: true, key: 'w', code: 'KeyW' }))).toBe(true);
    expect(matchCloseViewChord(ev({ altKey: true, key: '∑', code: 'KeyW' }))).toBe(true);
  });

  it('rejects other modifier combos', () => {
    expect(matchCloseViewChord(ev({ metaKey: true, shiftKey: true, key: 'w', code: 'KeyW' }))).toBe(false);
    expect(matchCloseViewChord(ev({ ctrlKey: true, key: 'w', code: 'KeyW' }))).toBe(false);
    expect(matchCloseViewChord(ev({ key: 'w', code: 'KeyW' }))).toBe(false);
  });

  const fakeInput = { tagName: 'INPUT', classList: { contains: () => false } } as unknown as EventTarget;
  const fakeXtermTa = {
    tagName: 'TEXTAREA',
    classList: { contains: (n: string) => n === 'xterm-helper-textarea' },
  } as unknown as EventTarget;

  it('⌥W leaves ordinary editable targets alone but fires on the xterm textarea', () => {
    expect(matchCloseViewChord(ev({ altKey: true, code: 'KeyW', target: fakeInput }))).toBe(false);
    expect(matchCloseViewChord(ev({ altKey: true, code: 'KeyW', target: fakeXtermTa }))).toBe(true);
  });

  it('⌘W fires regardless of target (pure app chord)', () => {
    expect(matchCloseViewChord(ev({ metaKey: true, key: 'w', code: 'KeyW', target: fakeInput }))).toBe(true);
  });
});

describe('closeViewTarget (B-089: ⌘W closes the SESSION, not the view)', () => {
  it('a chat session view targets the session (archive flow)', () => {
    expect(closeViewTarget('/session/abc', '')).toEqual({ kind: 'session', sessionId: 'abc' });
    // trailing slash tolerated (same location, same target)
    expect(closeViewTarget('/session/abc/', '')).toEqual({ kind: 'session', sessionId: 'abc' });
  });

  it('an open terminal view targets machine + terminal (close flow)', () => {
    expect(closeViewTarget('/terminal/m1', '?tid=t1')).toEqual({
      kind: 'terminal', machineId: 'm1', terminalId: 't1',
    });
  });

  it('decodes URL-encoded ids', () => {
    expect(closeViewTarget('/session/a%20b', '')).toEqual({ kind: 'session', sessionId: 'a b' });
    expect(closeViewTarget('/terminal/m%2F1', '?tid=t1')).toEqual({
      kind: 'terminal', machineId: 'm/1', terminalId: 't1',
    });
  });

  it('the terminal picker and machine route without ?tid carry no target', () => {
    expect(closeViewTarget('/terminal', '')).toBe(null);
    expect(closeViewTarget('/terminal/m1', '')).toBe(null);
  });

  it('non-session views carry no target — the chord stays with the browser', () => {
    expect(closeViewTarget('/', '')).toBe(null);
    expect(closeViewTarget('/board', '')).toBe(null);
    expect(closeViewTarget('/assistant', '')).toBe(null);
    expect(closeViewTarget('/settings/appearance', '')).toBe(null);
    expect(closeViewTarget('/machine/m1', '')).toBe(null);
  });
});

describe('isClosableViewPath', () => {
  it('session and open-terminal views are closable; picker and home are not', () => {
    expect(isClosableViewPath('/session/abc', '')).toBe(true);
    expect(isClosableViewPath('/terminal/m1', '?tid=t1')).toBe(true);
    expect(isClosableViewPath('/terminal', '')).toBe(false);
    expect(isClosableViewPath('/terminal/m1', '')).toBe(false);
    expect(isClosableViewPath('/', '')).toBe(false);
    expect(isClosableViewPath('/board', '')).toBe(false);
  });
});

describe('closeViewAction', () => {
  const on = { closable: true, confirmEnabled: true, confirmOpen: false };

  it('asks first when the confirm setting is on', () => {
    expect(closeViewAction(on)).toBe('confirm');
  });

  it('closes straight away when confirmation is switched off', () => {
    expect(closeViewAction({ ...on, confirmEnabled: false })).toBe('close');
  });

  it('leaves the event alone outside a closable view (⌥W must still type ∑)', () => {
    expect(closeViewAction({ ...on, closable: false })).toBe('none');
    expect(closeViewAction({ closable: false, confirmEnabled: false, confirmOpen: true })).toBe('none');
  });

  it('swallows repeats while the dialog is up (no dialog stacking, no keystroke leaking to xterm)', () => {
    expect(closeViewAction({ ...on, confirmOpen: true })).toBe('swallow');
    // even with confirmation off: a dialog can only be open if it was on
    expect(closeViewAction({ ...on, confirmEnabled: false, confirmOpen: true })).toBe('swallow');
  });
});

describe('shouldWarnOnUnload', () => {
  const base = { enabled: true, pathname: '/session/abc', search: '', programmaticReload: false };

  it('arms on a closable view only', () => {
    expect(shouldWarnOnUnload(base)).toBe(true);
    expect(shouldWarnOnUnload({ ...base, pathname: '/terminal/m1', search: '?tid=t1' })).toBe(true);
    expect(shouldWarnOnUnload({ ...base, pathname: '/' })).toBe(false);
    expect(shouldWarnOnUnload({ ...base, pathname: '/board' })).toBe(false);
    expect(shouldWarnOnUnload({ ...base, pathname: '/terminal', search: '' })).toBe(false);
  });

  it('stands down when the setting is off', () => {
    expect(shouldWarnOnUnload({ ...base, enabled: false })).toBe(false);
  });

  it('stands down for our own programmatic reload (auto-update must not be blocked)', () => {
    expect(shouldWarnOnUnload({ ...base, programmaticReload: true })).toBe(false);
  });
});

describe('programmatic-reload flag', () => {
  beforeEach(() => resetProgrammaticReload());

  it('is off by default', () => {
    expect(isProgrammaticReloadPending()).toBe(false);
  });

  it('is on right after marking and expires (never disarms the guard forever)', () => {
    const t0 = 1_000_000;
    markProgrammaticReload(t0);
    expect(isProgrammaticReloadPending(t0)).toBe(true);
    expect(isProgrammaticReloadPending(t0 + PROGRAMMATIC_RELOAD_WINDOW_MS - 1)).toBe(true);
    expect(isProgrammaticReloadPending(t0 + PROGRAMMATIC_RELOAD_WINDOW_MS)).toBe(false);
  });

  it('feeds shouldWarnOnUnload: marked → no dialog, expired → dialog again', () => {
    const t0 = 2_000_000;
    const view = { enabled: true, pathname: '/session/abc', search: '' };
    markProgrammaticReload(t0);
    expect(shouldWarnOnUnload({ ...view, programmaticReload: isProgrammaticReloadPending(t0) })).toBe(false);
    expect(
      shouldWarnOnUnload({
        ...view,
        programmaticReload: isProgrammaticReloadPending(t0 + PROGRAMMATIC_RELOAD_WINDOW_MS),
      }),
    ).toBe(true);
  });
});

describe('pickRefocusTarget', () => {
  const captured = { isConnected: true, name: 'xterm' };
  const fallback = { isConnected: true, name: 'fallback' };
  const body = { isConnected: true, name: 'body' };

  it('returns the captured element when it is still in the document', () => {
    expect(pickRefocusTarget(captured, fallback, body)).toBe(captured);
  });

  it('falls back when the captured element went away, was <body>, or was never there', () => {
    expect(pickRefocusTarget({ isConnected: false, name: 'gone' }, fallback, body)).toBe(fallback);
    expect(pickRefocusTarget(body, fallback, body)).toBe(fallback);
    expect(pickRefocusTarget(null, fallback, body)).toBe(fallback);
  });

  it('returns null when there is nothing to focus', () => {
    expect(pickRefocusTarget(null, null, body)).toBe(null);
  });
});
