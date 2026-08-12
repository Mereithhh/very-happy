import { describe, it, expect } from 'vitest';
import { matchPresetsMenuChord, presetDigitIndex } from './presetsShortcut';

function ev(over: Partial<Parameters<typeof matchPresetsMenuChord>[0]> = {}) {
  return {
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    code: '', target: null,
    ...over,
  };
}

describe('matchPresetsMenuChord', () => {
  it('matches ⌘. and Ctrl+.', () => {
    expect(matchPresetsMenuChord(ev({ metaKey: true, code: 'Period' }))).toBe(true);
    expect(matchPresetsMenuChord(ev({ ctrlKey: true, code: 'Period' }))).toBe(true);
  });

  it('rejects other modifier combos', () => {
    expect(matchPresetsMenuChord(ev({ code: 'Period' }))).toBe(false); // bare '.'
    expect(matchPresetsMenuChord(ev({ metaKey: true, ctrlKey: true, code: 'Period' }))).toBe(false);
    expect(matchPresetsMenuChord(ev({ metaKey: true, shiftKey: true, code: 'Period' }))).toBe(false);
    expect(matchPresetsMenuChord(ev({ metaKey: true, altKey: true, code: 'Period' }))).toBe(false);
    expect(matchPresetsMenuChord(ev({ ctrlKey: true, shiftKey: true, code: 'Period' }))).toBe(false);
    expect(matchPresetsMenuChord(ev({ altKey: true, code: 'Period' }))).toBe(false);
  });

  it('rejects other keys under the same modifiers', () => {
    expect(matchPresetsMenuChord(ev({ metaKey: true, code: 'Comma' }))).toBe(false);
    expect(matchPresetsMenuChord(ev({ ctrlKey: true, code: 'Slash' }))).toBe(false);
    expect(matchPresetsMenuChord(ev({ metaKey: true, code: 'KeyW' }))).toBe(false);
  });

  const fakeInput = { tagName: 'INPUT', classList: { contains: () => false } } as unknown as EventTarget;
  const fakeXtermTa = {
    tagName: 'TEXTAREA',
    classList: { contains: (n: string) => n === 'xterm-helper-textarea' },
  } as unknown as EventTarget;

  it('fires on editable targets — including the xterm helper textarea', () => {
    // The chord's whole point is working while the caret sits in the composer
    // textarea (chat) or the xterm helper textarea (terminal).
    expect(matchPresetsMenuChord(ev({ metaKey: true, code: 'Period', target: fakeInput }))).toBe(true);
    expect(matchPresetsMenuChord(ev({ metaKey: true, code: 'Period', target: fakeXtermTa }))).toBe(true);
    expect(matchPresetsMenuChord(ev({ ctrlKey: true, code: 'Period', target: fakeXtermTa }))).toBe(true);
  });
});

describe('presetDigitIndex', () => {
  it('maps 1-9 to 0-8 within range', () => {
    expect(presetDigitIndex('1', 3)).toBe(0);
    expect(presetDigitIndex('3', 3)).toBe(2);
    expect(presetDigitIndex('9', 12)).toBe(8);
  });

  it('rejects out-of-range digits and non-digits', () => {
    expect(presetDigitIndex('4', 3)).toBe(null);
    expect(presetDigitIndex('0', 3)).toBe(null);
    expect(presetDigitIndex('a', 3)).toBe(null);
    expect(presetDigitIndex('Enter', 3)).toBe(null);
    expect(presetDigitIndex('', 3)).toBe(null);
    expect(presetDigitIndex('1', 0)).toBe(null);
  });
});
