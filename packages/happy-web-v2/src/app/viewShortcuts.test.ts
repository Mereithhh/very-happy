import { describe, it, expect } from 'vitest';
import { matchCloseViewChord, isClosableViewPath } from './viewShortcuts';

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

  it('⌥W leaves ordinary editable targets alone but fires on the xterm textarea', () => {
    const input = document.createElement('input');
    expect(matchCloseViewChord(ev({ altKey: true, code: 'KeyW', target: input }))).toBe(false);
    const ta = document.createElement('textarea');
    ta.classList.add('xterm-helper-textarea');
    expect(matchCloseViewChord(ev({ altKey: true, code: 'KeyW', target: ta }))).toBe(true);
  });

  it('⌘W fires regardless of target (pure app chord)', () => {
    const input = document.createElement('input');
    expect(matchCloseViewChord(ev({ metaKey: true, key: 'w', code: 'KeyW', target: input }))).toBe(true);
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
