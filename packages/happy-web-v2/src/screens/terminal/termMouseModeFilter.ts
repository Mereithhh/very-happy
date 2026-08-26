/**
 * DEC private mouse-tracking mode filter for xterm.js — keeps native text
 * selection alive when the inner TUI requests mouse reporting.
 *
 * Why: the daemon's tmux runs with `mouse off`, so an inner app's DECSET
 * mouse-tracking requests (Claude Code's TUI ≥2.1.226 enables mouse reporting)
 * pass straight through to the outer xterm. Per spec, xterm hands the mouse to
 * the application while a tracking protocol is active — it stops making native
 * selections, so drag-select in the web terminal silently does nothing (and
 * copy-on-select with it). Swallow the modes before xterm's input handler sees
 * them so clicks remain available for focus/selection. The screen separately
 * tracks exact SGR capability and forwards touch-wheel reports through the
 * realtime input lane; unsupported encodings keep the `terminal-scroll` RPC
 * compatibility path.
 *
 * Filtered modes (set/reset alike):
 *   9 (X10), 1000 (VT200), 1002 (drag), 1003 (any-motion) — protocols
 *   1005 (UTF-8 ext), 1006 (SGR), 1015 (urxvt), 1016 (SGR-pixel) — encodings
 * Everything else (25 cursor, 47/1047/1049 alt screen, 2004 bracketed paste,
 * 1004 focus events, …) must keep working — including when it arrives in the
 * SAME sequence as a mouse mode (`CSI ?1049;1002;1006 h` is legal).
 *
 * Partial swallowing: xterm's public CSI handler contract is all-or-nothing —
 * `return false` falls through to the built-in handler with the FULL param
 * list, `return true` consumes the whole sequence. So for a mixed sequence we
 * consume it and replay only the non-mouse params through the core input
 * handler's `setModePrivate`/`resetModePrivate`, SYNCHRONOUSLY. (A
 * `term.write('\x1b[?…')` replay would be appended to the write queue and run
 * after the rest of the current chunk — an alt-screen switch would then apply
 * AFTER content that was meant to be drawn inside it.) The core call is a
 * private API (`_core._inputHandler`), same dependency class as the existing
 * `_core._charSizeService` / `_core._compositionHelper` uses in this app;
 * verified present in the shipped @xterm/xterm 5.5.0 build, and both methods
 * consume exactly `{ length, params[] }` — covered by unit tests against the
 * real Terminal.
 */
import type { Terminal } from '@xterm/xterm';

/** DECSET/DECRST parameter values that enable/configure mouse tracking. */
export const MOUSE_TRACKING_DEC_MODES: ReadonlySet<number> = new Set([
    9, 1000, 1002, 1003, 1005, 1006, 1015, 1016,
]);

/**
 * Split a DECSET/DECRST param list into mouse-tracking params and the rest.
 * Sub-params (`number[]` entries from the public parser API) are never valid
 * mouse modes → always "rest". Pure; unit-tested.
 */
export function splitMouseModeParams(
    params: (number | number[])[],
): { mouse: number[]; rest: (number | number[])[] } {
    const mouse: number[] = [];
    const rest: (number | number[])[] = [];
    for (const p of params) {
        if (typeof p === 'number' && MOUSE_TRACKING_DEC_MODES.has(p)) mouse.push(p);
        else rest.push(p);
    }
    return { mouse, rest };
}

export interface MouseModeFilterHandle {
    /** The inner application currently accepts cell-coordinate SGR wheel reports. */
    sgrWheelRequested(): boolean;
    dispose(): void;
}

/**
 * Install the filter on a terminal. Must run after construction (parser API
 * needs `allowProposedApi: true`, which the renderer sets). Custom handlers
 * run before xterm's built-in one, so returning `true` fully consumes a
 * sequence and `false` defers to the default behavior.
 */
export function installMouseModeFilter(term: Terminal): MouseModeFilterHandle {
    // Protocol modes mean “send mouse events”; encoding-only modes such as
    // 1006 do not. Track the swallowed requests so touch can forward SGR wheel
    // reports without enabling xterm's click capture (native selection stays).
    const activeMouseModes = new Set<number>();
    const isProtocol = (mode: number) => mode === 9 || mode === 1000 || mode === 1002 || mode === 1003;
    const replay = (rest: (number | number[])[], set: boolean) => {
        const ih = (term as unknown as { _core?: any })._core?._inputHandler;
        if (!ih) return;
        // Duck-typed IParams: setModePrivate/resetModePrivate read only
        // `.length` and `.params[i]` (sub-param arrays fall through their
        // switch just like in the built-in path).
        const duck = { length: rest.length, params: rest };
        try {
            if (set) ih.setModePrivate(duck);
            else ih.resetModePrivate(duck);
        } catch { /* private API best-effort — worst case the mode is dropped */ }
    };
    const handle = (params: (number | number[])[], set: boolean): boolean => {
        const { mouse, rest } = splitMouseModeParams(params);
        if (mouse.length === 0) return false; // nothing to filter → default path
        for (const mode of mouse) {
            if (set) activeMouseModes.add(mode);
            else activeMouseModes.delete(mode);
        }
        if (rest.length > 0) replay(rest, set); // mixed sequence → partial swallow
        return true;
    };
    const h = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => handle(p, true));
    const l = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => handle(p, false));
    return {
        // 1006 is the cell-coordinate SGR encoding emitted by termTuiScroll.
        // Do not fast-path X10/UTF-8/urxvt/pixel protocols with the wrong wire
        // shape; those stay on the daemon's compatibility RPC.
        sgrWheelRequested: () =>
            activeMouseModes.has(1006) && [...activeMouseModes].some(isProtocol),
        dispose() {
            h.dispose();
            l.dispose();
            activeMouseModes.clear();
        },
    };
}
