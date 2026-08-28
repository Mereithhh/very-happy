import { describe, expect, it } from 'vitest';
import {
    ALPHA_WEB_KEYBOARD_ROWS,
    SYMBOL_WEB_KEYBOARD_ROWS,
    initialWebKeyboardState,
    pressWebKeyboardKey,
    type WebKeyboardKey,
} from './webKeyboardModel';

const keys = (rows: typeof ALPHA_WEB_KEYBOARD_ROWS): WebKeyboardKey[] =>
    rows.flatMap((row) => [...row.keys]);

describe('termWebKeyboard', () => {
    it('covers the complete printable ASCII range while staying English-only', () => {
        const output = new Set<string>();
        for (const key of keys(ALPHA_WEB_KEYBOARD_ROWS)) {
            if (key.kind !== 'text') continue;
            output.add(key.value);
            if (key.shifted) output.add(key.shifted);
        }
        for (const key of keys(SYMBOL_WEB_KEYBOARD_ROWS)) {
            if (key.kind === 'text') output.add(key.value);
            if (key.kind === 'space') output.add(' ');
        }
        output.add(' ');

        const printableAscii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));
        expect([...output].sort()).toEqual(printableAscii.sort());
    });

    it('emits terminal DEL/CR bytes for Backspace and Enter', () => {
        const backspace = keys(ALPHA_WEB_KEYBOARD_ROWS).find((key) => key.kind === 'backspace')!;
        const enter = keys(ALPHA_WEB_KEYBOARD_ROWS).find((key) => key.kind === 'enter')!;
        expect(pressWebKeyboardKey(initialWebKeyboardState, backspace).bytes).toBe('\x7f');
        expect(pressWebKeyboardKey(initialWebKeyboardState, enter).bytes).toBe('\r');
    });

    it('supports one-shot Shift, Shift lock, and a clean symbol-page round trip', () => {
        const shift = keys(ALPHA_WEB_KEYBOARD_ROWS).find((key) => key.kind === 'shift')!;
        const q = keys(ALPHA_WEB_KEYBOARD_ROWS).find((key) => key.kind === 'text' && key.value === 'q')!;
        const layout = keys(ALPHA_WEB_KEYBOARD_ROWS).find((key) => key.kind === 'layout')!;

        let result = pressWebKeyboardKey(initialWebKeyboardState, shift);
        expect(result.state.shift).toBe('once');
        result = pressWebKeyboardKey(result.state, q);
        expect(result.bytes).toBe('Q');
        expect(result.state.shift).toBe('off');

        result = pressWebKeyboardKey(result.state, shift);
        result = pressWebKeyboardKey(result.state, shift);
        expect(result.state.shift).toBe('locked');
        result = pressWebKeyboardKey(result.state, q);
        expect(result.bytes).toBe('Q');
        expect(result.state.shift).toBe('locked');

        result = pressWebKeyboardKey(result.state, layout);
        expect(result.state).toEqual({ layout: 'symbols', shift: 'off' });
        result = pressWebKeyboardKey(result.state, layout);
        expect(result.state).toEqual(initialWebKeyboardState);
    });
});
