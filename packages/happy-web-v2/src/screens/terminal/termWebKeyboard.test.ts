import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    ALPHA_WEB_KEYBOARD_ROWS,
    SYMBOL_WEB_KEYBOARD_ROWS,
    initialWebKeyboardState,
    pressWebKeyboardKey,
    type WebKeyboardKey,
} from './webKeyboardModel';
import {
    WEB_KEYBOARD_REPEAT_DELAY_MS,
    WEB_KEYBOARD_REPEAT_INTERVAL_MS,
    createWebKeyboardRepeatController,
} from './termWebKeyboardRepeat';

const keys = (rows: typeof ALPHA_WEB_KEYBOARD_ROWS): WebKeyboardKey[] =>
    rows.flatMap((row) => [...row.keys]);

const component = readFileSync(
    fileURLToPath(new URL('./TermWebKeyboard.tsx', import.meta.url)),
    'utf8',
);

describe('termWebKeyboard', () => {
    afterEach(() => vi.useRealTimers());

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

    it('keeps Backspace available on both layouts and emits all ANSI cursor keys', () => {
        expect(keys(ALPHA_WEB_KEYBOARD_ROWS).some((key) => key.kind === 'backspace')).toBe(true);
        expect(keys(SYMBOL_WEB_KEYBOARD_ROWS).some((key) => key.kind === 'backspace')).toBe(true);

        const expected = {
            up: '\x1b[A',
            down: '\x1b[B',
            right: '\x1b[C',
            left: '\x1b[D',
        } as const;
        for (const [direction, bytes] of Object.entries(expected)) {
            for (const rows of [ALPHA_WEB_KEYBOARD_ROWS, SYMBOL_WEB_KEYBOARD_ROWS]) {
                const arrow = keys(rows).find(
                    (key) => key.kind === 'arrow' && key.direction === direction,
                )!;
                expect(pressWebKeyboardKey(initialWebKeyboardState, arrow).bytes).toBe(bytes);
            }
        }
    });

    it('repeats immediately after the hold delay and stops without a trailing delete', () => {
        vi.useFakeTimers();
        const repeat = vi.fn();
        const controller = createWebKeyboardRepeatController();

        controller.start(repeat);
        expect(repeat).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(WEB_KEYBOARD_REPEAT_DELAY_MS - 1);
        expect(repeat).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(repeat).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(WEB_KEYBOARD_REPEAT_INTERVAL_MS * 3);
        expect(repeat).toHaveBeenCalledTimes(5);
        controller.stop();
        vi.advanceTimersByTime(WEB_KEYBOARD_REPEAT_INTERVAL_MS * 3);
        expect(repeat).toHaveBeenCalledTimes(5);
    });

    it('cancels an earlier hold before starting another repeat sequence', () => {
        vi.useFakeTimers();
        const first = vi.fn();
        const second = vi.fn();
        const controller = createWebKeyboardRepeatController();

        controller.start(first);
        vi.advanceTimersByTime(WEB_KEYBOARD_REPEAT_DELAY_MS - 1);
        controller.start(second);
        vi.advanceTimersByTime(WEB_KEYBOARD_REPEAT_DELAY_MS);

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
    });

    it('wires every pointer and lifecycle cancellation boundary to the repeat controller', () => {
        expect(component).toContain('onPointerUp={repeatable ? stopRepeat : undefined}');
        expect(component).toContain('onPointerCancel={repeatable ? stopRepeat : undefined}');
        expect(component).toContain('onPointerLeave={repeatable ? stopRepeat : undefined}');
        expect(component).toContain('onLostPointerCapture={repeatable ? stopRepeat : undefined}');
        expect(component).toContain("window.addEventListener('blur', stopRepeat)");
        expect(component).toContain("document.addEventListener('visibilitychange', stopOnVisibilityLoss)");
        expect(component).toMatch(/return \(\) => \{[\s\S]{0,350}stopRepeat\(\);/);
        expect(component).toContain("event.detail !== 0");
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
