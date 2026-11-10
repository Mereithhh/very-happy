import { describe, it, expect } from 'vitest';
import { mainAgentAskTrigger } from './mainAgentPalette';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('mainAgentAskTrigger (⌘K → main agent)', () => {
    it('⌘↩ / Ctrl+↩ with a query asks the main agent', () => {
        expect(mainAgentAskTrigger(key('Enter', { metaKey: true }), 'status?')).toBe(true);
        expect(mainAgentAskTrigger(key('Enter', { ctrlKey: true }), 'status?')).toBe(true);
    });
    it('plain ↩, other modifiers, or an empty query keep the normal behaviour', () => {
        expect(mainAgentAskTrigger(key('Enter'), 'status?')).toBe(false);
        expect(mainAgentAskTrigger(key('Enter', { metaKey: true, shiftKey: true }), 'x')).toBe(false);
        expect(mainAgentAskTrigger(key('Enter', { metaKey: true, altKey: true }), 'x')).toBe(false);
        expect(mainAgentAskTrigger(key('Enter', { metaKey: true }), '   ')).toBe(false);
        expect(mainAgentAskTrigger(key('k', { metaKey: true }), 'x')).toBe(false);
    });
});

describe('isMainAgentChord (drawer toggle)', () => {
    it('⌘⇧E / Ctrl+Shift+E by physical key; not ⌘E, not ⌘⇧A (browser tab search)', async () => {
        const { isMainAgentChord } = await import('./mainAgentPalette');
        const ev = (code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
        expect(isMainAgentChord(ev('KeyE', { metaKey: true, shiftKey: true }))).toBe(true);
        expect(isMainAgentChord(ev('KeyE', { ctrlKey: true, shiftKey: true }))).toBe(true);
        expect(isMainAgentChord(ev('KeyE', { metaKey: true }))).toBe(false);
        expect(isMainAgentChord(ev('KeyA', { metaKey: true, shiftKey: true }))).toBe(false);
        expect(isMainAgentChord(ev('KeyE', { metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    });
});
