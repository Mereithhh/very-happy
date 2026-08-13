import { describe, it, expect } from 'vitest';
import {
  backParentPath,
  resolveBackTarget,
  matchBackChord,
  navHubFor,
  type BackOrigin,
} from './appBack';

// ---------------------------------------------------------------------------
// the parent table — one case per route the app can be standing on
// ---------------------------------------------------------------------------

describe('backParentPath', () => {
  const cases: Array<[string, string, BackOrigin | null, string | null]> = [
    // route,                    search,        origin,   parent
    ['/', '', null, null],
    ['', '', null, null],
    ['/login', '', null, null],
    ['/signup', '', null, null],
    ['/board', '', null, '/'],
    ['/board', '', 'board', '/'], // never points at itself
    ['/session/abc', '', null, '/'],
    ['/session/abc', '', 'home', '/'],
    ['/session/abc', '', 'board', '/board'],
    ['/terminal', '', null, '/'],
    ['/terminal', '', 'board', '/'], // the picker is a chooser, not a board child
    ['/terminal/m1', '', null, '/'],
    ['/terminal/m1', '?tid=t1', null, '/'],
    ['/terminal/m1', '?tid=t1', 'board', '/board'],
    ['/machine/m1', '', null, '/settings/machines'],
    ['/machine/m1', '', 'board', '/settings/machines'], // IA wins over origin
    ['/settings', '', null, '/'],
    ['/settings/', '', null, '/'],
    ['/settings/appearance', '', null, '/settings'],
    ['/settings/diagnostics', '', null, '/settings'],
    ['/assistant', '', null, '/'],
    ['/whatever-unknown', '', null, '/'],
  ];
  for (const [pathname, search, origin, expected] of cases) {
    it(`${pathname || '(empty)'}${search}${origin ? ` from ${origin}` : ''} → ${expected}`, () => {
      expect(backParentPath(pathname, search, origin)).toBe(expected);
    });
  }
});

describe('navHubFor', () => {
  it('recognises the two list surfaces and nothing else', () => {
    expect(navHubFor('/')).toBe('home');
    expect(navHubFor('/board')).toBe('board');
    expect(navHubFor('/board/')).toBe('board');
    expect(navHubFor('/session/a')).toBe(null);
    expect(navHubFor('/settings')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// history vs hierarchy
// ---------------------------------------------------------------------------

describe('resolveBackTarget', () => {
  it('prefers real in-app history — this is what returns you to the previous chat', () => {
    expect(
      resolveBackTarget({ pathname: '/session/a', search: '', depth: 1, origin: 'home' }),
    ).toEqual({ kind: 'history' });
    expect(
      resolveBackTarget({ pathname: '/settings/appearance', search: '', depth: 3, origin: null }),
    ).toEqual({ kind: 'history' });
  });

  it('falls back to the hierarchical parent with an empty stack (deep link / cold start / reload)', () => {
    expect(
      resolveBackTarget({ pathname: '/session/a', search: '', depth: 0, origin: null }),
    ).toEqual({ kind: 'path', to: '/' });
    expect(
      resolveBackTarget({ pathname: '/session/a', search: '', depth: 0, origin: 'board' }),
    ).toEqual({ kind: 'path', to: '/board' });
    expect(
      resolveBackTarget({ pathname: '/terminal/m1', search: '?tid=t1', depth: 0, origin: 'board' }),
    ).toEqual({ kind: 'path', to: '/board' });
    expect(
      resolveBackTarget({ pathname: '/settings/appearance', search: '', depth: 0, origin: null }),
    ).toEqual({ kind: 'path', to: '/settings' });
    expect(
      resolveBackTarget({ pathname: '/settings', search: '', depth: 0, origin: null }),
    ).toEqual({ kind: 'path', to: '/' });
    expect(
      resolveBackTarget({ pathname: '/machine/m1', search: '', depth: 0, origin: null }),
    ).toEqual({ kind: 'path', to: '/settings/machines' });
    expect(
      resolveBackTarget({ pathname: '/board', search: '', depth: 0, origin: 'board' }),
    ).toEqual({ kind: 'path', to: '/' });
  });

  it('shows nothing at the root, even with history behind it', () => {
    expect(resolveBackTarget({ pathname: '/', search: '', depth: 0, origin: null })).toEqual({
      kind: 'none',
    });
    expect(resolveBackTarget({ pathname: '/', search: '', depth: 5, origin: 'board' })).toEqual({
      kind: 'none',
    });
    expect(resolveBackTarget({ pathname: '/login', search: '', depth: 2, origin: null })).toEqual({
      kind: 'none',
    });
  });
});

// ---------------------------------------------------------------------------
// chord
// ---------------------------------------------------------------------------

describe('matchBackChord', () => {
  function ev(over: Partial<Parameters<typeof matchBackChord>[0]> = {}) {
    return {
      metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      key: '', code: '', target: null,
      ...over,
    };
  }

  const fakeInput = { tagName: 'INPUT', classList: { contains: () => false } } as unknown as EventTarget;
  const fakeXtermTa = {
    tagName: 'TEXTAREA',
    classList: { contains: (n: string) => n === 'xterm-helper-textarea' },
  } as unknown as EventTarget;

  it('matches ⌘[ (by key and by code, for non-US layouts)', () => {
    expect(matchBackChord(ev({ metaKey: true, key: '[', code: 'BracketLeft' }))).toBe(true);
    expect(matchBackChord(ev({ metaKey: true, key: '“', code: 'BracketLeft' }))).toBe(true);
  });

  it('matches Alt+←', () => {
    expect(matchBackChord(ev({ altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' }))).toBe(true);
  });

  it('rejects other combos and bare keys', () => {
    expect(matchBackChord(ev({ key: '[', code: 'BracketLeft' }))).toBe(false);
    expect(matchBackChord(ev({ key: 'ArrowLeft', code: 'ArrowLeft' }))).toBe(false);
    expect(matchBackChord(ev({ metaKey: true, shiftKey: true, key: '[', code: 'BracketLeft' }))).toBe(false);
    expect(matchBackChord(ev({ ctrlKey: true, key: '[', code: 'BracketLeft' }))).toBe(false);
    expect(matchBackChord(ev({ metaKey: true, altKey: true, key: 'ArrowLeft' }))).toBe(false);
    expect(matchBackChord(ev({ metaKey: true, key: ']', code: 'BracketRight' }))).toBe(false);
  });

  it('Alt+← never fires in an editable target — it is word-left there, and in the shell', () => {
    expect(matchBackChord(ev({ altKey: true, key: 'ArrowLeft', target: fakeInput }))).toBe(false);
    // Unlike ⌥W in viewShortcuts.ts, the xterm textarea is NOT an exception:
    // Alt+← is a real readline binding inside the terminal.
    expect(matchBackChord(ev({ altKey: true, key: 'ArrowLeft', target: fakeXtermTa }))).toBe(false);
  });

  it('⌘[ fires on every target — including the terminal, which is the point', () => {
    expect(matchBackChord(ev({ metaKey: true, key: '[', code: 'BracketLeft', target: fakeInput }))).toBe(true);
    expect(matchBackChord(ev({ metaKey: true, key: '[', code: 'BracketLeft', target: fakeXtermTa }))).toBe(true);
  });
});
