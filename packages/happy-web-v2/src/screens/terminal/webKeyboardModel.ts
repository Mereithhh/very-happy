/**
 * Pure state + layout for the mobile Web terminal keyboard (B-255).
 *
 * The keyboard deliberately emits bytes instead of editing a hidden input:
 * the browser/OS never gets a chance to autocorrect, capitalize, compose, or
 * reinterpret a key. Together the two layouts cover every printable ASCII
 * character (English terminal input), plus DEL and CR.
 */

export type WebKeyboardLayout = 'alpha' | 'symbols';
export type WebKeyboardShift = 'off' | 'once' | 'locked';

export interface WebKeyboardState {
    layout: WebKeyboardLayout;
    shift: WebKeyboardShift;
}

export type WebKeyboardKey =
    | { id: string; kind: 'text'; value: string; shifted?: string; units?: number }
    | { id: string; kind: 'space' | 'backspace' | 'enter'; units?: number }
    | { id: string; kind: 'shift' | 'layout'; units?: number };

export interface WebKeyboardRow {
    id: string;
    inset?: number;
    keys: readonly WebKeyboardKey[];
}

const text = (value: string, shifted?: string): WebKeyboardKey => ({
    id: `text-${value.codePointAt(0)?.toString(16) ?? value}`,
    kind: 'text',
    value,
    shifted,
});

const letters = (value: string): WebKeyboardKey[] =>
    [...value].map((letter) => text(letter, letter.toUpperCase()));

export const ALPHA_WEB_KEYBOARD_ROWS: readonly WebKeyboardRow[] = Object.freeze([
    { id: 'qwerty', keys: letters('qwertyuiop') },
    { id: 'home', inset: 0.45, keys: letters('asdfghjkl') },
    {
        id: 'lower',
        keys: [
            { id: 'shift', kind: 'shift', units: 1.45 },
            ...letters('zxcvbnm'),
            { id: 'backspace', kind: 'backspace', units: 1.45 },
        ],
    },
    {
        id: 'punctuation',
        inset: 0.2,
        keys: [
            text('-', '_'), text('=', '+'), text('[', '{'), text(']', '}'),
            text('\\', '|'), text(';', ':'), text("'", '"'), text('`', '~'),
        ],
    },
    {
        id: 'alpha-controls',
        keys: [
            { id: 'symbols', kind: 'layout', units: 1.45 },
            text(',', '<'),
            { id: 'space', kind: 'space', units: 4.1 },
            text('.', '>'),
            text('/', '?'),
            { id: 'enter', kind: 'enter', units: 1.65 },
        ],
    },
]);

export const SYMBOL_WEB_KEYBOARD_ROWS: readonly WebKeyboardRow[] = Object.freeze([
    { id: 'digits', keys: [...'1234567890'].map((value) => text(value)) },
    { id: 'shifted-digits', keys: [...'!@#$%^&*()'].map((value) => text(value)) },
    { id: 'operators', keys: [...'-_=+[]{}\\|'].map((value) => text(value)) },
    { id: 'more-punctuation', keys: [..."`~;:'\",<.>"].map((value) => text(value)) },
    {
        id: 'symbol-controls',
        keys: [
            { id: 'letters', kind: 'layout', units: 1.45 },
            { id: 'space', kind: 'space', units: 4.1 },
            text('/'),
            text('?'),
            { id: 'enter', kind: 'enter', units: 1.65 },
        ],
    },
]);

export const initialWebKeyboardState: WebKeyboardState = Object.freeze({
    layout: 'alpha',
    shift: 'off',
});

function nextShift(shift: WebKeyboardShift): WebKeyboardShift {
    if (shift === 'off') return 'once';
    if (shift === 'once') return 'locked';
    return 'off';
}

export function webKeyboardRows(layout: WebKeyboardLayout): readonly WebKeyboardRow[] {
    return layout === 'alpha' ? ALPHA_WEB_KEYBOARD_ROWS : SYMBOL_WEB_KEYBOARD_ROWS;
}

export function pressWebKeyboardKey(
    state: WebKeyboardState,
    key: WebKeyboardKey,
): { state: WebKeyboardState; bytes: string | null } {
    if (key.kind === 'shift') {
        return {
            state: { layout: 'alpha', shift: nextShift(state.shift) },
            bytes: null,
        };
    }
    if (key.kind === 'layout') {
        return {
            state: {
                layout: state.layout === 'alpha' ? 'symbols' : 'alpha',
                shift: 'off',
            },
            bytes: null,
        };
    }

    let bytes: string;
    switch (key.kind) {
        case 'backspace':
            bytes = '\x7f';
            break;
        case 'enter':
            bytes = '\r';
            break;
        case 'space':
            bytes = ' ';
            break;
        case 'text':
            bytes = state.layout === 'alpha' && state.shift !== 'off' && key.shifted
                ? key.shifted
                : key.value;
            break;
    }

    return {
        state: state.shift === 'once' ? { ...state, shift: 'off' } : state,
        bytes,
    };
}

export function webKeyboardKeyLabel(key: WebKeyboardKey, state: WebKeyboardState): string {
    switch (key.kind) {
        case 'shift':
            return state.shift === 'locked' ? '⇪' : '⇧';
        case 'layout':
            return state.layout === 'alpha' ? '123' : 'ABC';
        case 'backspace':
            return '⌫';
        case 'enter':
            return 'Enter';
        case 'space':
            return '';
        case 'text':
            return state.layout === 'alpha' && state.shift !== 'off' && key.shifted
                ? key.shifted
                : key.value;
    }
}
