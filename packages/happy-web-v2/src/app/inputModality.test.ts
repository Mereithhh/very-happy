// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installInputModality, modalityFor } from './inputModality';

describe('input modality (B-728)', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => { uninstall?.(); uninstall = null; delete document.documentElement.dataset.input; });

  it('maps events to modalities; bare modifiers do not flip to keyboard', () => {
    expect(modalityFor({ type: 'pointerdown' })).toBe('pointer');
    expect(modalityFor({ type: 'keydown', key: 'Tab' })).toBe('keyboard');
    expect(modalityFor({ type: 'keydown', key: 'Escape' })).toBe('keyboard');
    expect(modalityFor({ type: 'keydown', key: 'Meta' })).toBeNull();
    expect(modalityFor({ type: 'focus' })).toBeNull();
  });

  it('a touch-first device starts in pointer modality', () => {
    const doc = document.implementation.createHTMLDocument('x');
    Object.defineProperty(doc, 'defaultView', { value: { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }) } });
    const off = installInputModality(doc);
    expect(doc.documentElement.dataset.input).toBe('pointer');
    off();
  });

  it('tracks the last modality on <html data-input>', () => {
    uninstall = installInputModality(document);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.documentElement.dataset.input).toBe('pointer');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    expect(document.documentElement.dataset.input).toBe('pointer');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.documentElement.dataset.input).toBe('keyboard');
  });

});
