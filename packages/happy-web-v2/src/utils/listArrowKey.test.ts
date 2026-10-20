import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listArrowDelta } from './listArrowKey';

const MODS = ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const;

describe('B-655 listArrowDelta: only a bare ↑/↓ moves a list', () => {
    it('bare arrows move', () => {
        expect(listArrowDelta({ key: 'ArrowDown' })).toBe(1);
        expect(listArrowDelta({ key: 'ArrowUp' })).toBe(-1);
    });

    it.each(MODS)('%s + ↑/↓ is left to the text field', (mod) => {
        expect(listArrowDelta({ key: 'ArrowDown', [mod]: true })).toBeNull();
        expect(listArrowDelta({ key: 'ArrowUp', [mod]: true })).toBeNull();
    });

    it('other keys are not list keys', () => {
        for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End', 'j', 'k']) expect(listArrowDelta({ key })).toBeNull();
    });
});

/** Strip comments so an assertion can't be satisfied by the comment that explains the rule. */
function code(rel: string) {
    return readFileSync(resolve(__dirname, '..', rel), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('B-655 every text-field-driven list routes ↑/↓ through listArrowDelta', () => {
    it.each([
        ['screens/command/CommandPalette.tsx', 'setActive((a) => moveActive(keys, a, delta))'],
        ['screens/quickopen/QuickOpen.tsx', 'setActive((a) => (results.length ? (a + delta + results.length) % results.length : 0))'],
        ['screens/session/AgentInput.tsx', 'setSlashIndex((current) => (current + delta + slashSuggestions.length) % slashSuggestions.length)'],
    ])('%s', (file, move) => {
        const src = code(file);
        expect(src).toContain('const delta = listArrowDelta(e);');
        expect(src).toContain(move);
        // No handler may still match a raw arrow key: that is the B-655 bug shape.
        expect(src).not.toMatch(/e\.key === 'Arrow(Up|Down)'/);
    });
});
