import { describe, it, expect } from 'vitest';
import {
    reduceTermFocus,
    initialTermFocusState,
    completeTerminalTouchTap,
    TERMINAL_TOUCH_END_OPTIONS,
    type TermFocusState,
    type TermFocusEvent,
} from './termFocusPolicy';

const S = (over: Partial<TermFocusState> = {}): TermFocusState => ({
    ...initialTermFocusState,
    ...over,
});

describe('completeTerminalTouchTap', () => {
    const runTap = (overrides: Partial<Parameters<typeof completeTerminalTouchTap>[0]> = {}) => {
        const calls: string[] = [];
        const handled = completeTerminalTouchTap({
            inputOwnership: 'own',
            barMode: false,
            selectMode: false,
            distanceSquared: 0,
            threshold: 12,
            cancelable: true,
            scrolled: false,
            ...overrides,
        }, {
            preventDefault: () => calls.push('prevent-default'),
            stopPropagation: () => calls.push('stop-propagation'),
            dispatchTap: () => calls.push('dispatch-focus'),
        });
        return { handled, calls };
    };

    it('claims the first own-input tap and focuses synchronously after suppressing Chrome compatibility mouse events', () => {
        expect(runTap()).toEqual({
            handled: true,
            calls: ['prevent-default', 'stop-propagation', 'dispatch-focus'],
        });
        expect(runTap({ distanceSquared: 12 * 12 }).handled).toBe(true);
        expect(TERMINAL_TOUCH_END_OPTIONS).toEqual({ capture: true, passive: false });
    });

    it('leaves scroll, selection, and ordinary xterm-owned taps native', () => {
        expect(runTap({ distanceSquared: 12 * 12 + 1 })).toEqual({ handled: false, calls: [] });
        expect(runTap({ scrolled: true })).toEqual({ handled: false, calls: [] });
        expect(runTap({ selectMode: true })).toEqual({ handled: false, calls: [] });
        expect(runTap({ inputOwnership: 'xterm' })).toEqual({ handled: true, calls: ['dispatch-focus'] });
    });

    it('claims a body tap in line-input mode so Chrome cannot reopen xterm after the bar blurs', () => {
        expect(runTap({ inputOwnership: 'xterm', barMode: true })).toEqual({
            handled: true,
            calls: ['prevent-default', 'stop-propagation', 'dispatch-focus'],
        });
    });

    it('skips preventDefault but still dispatches focus synchronously for a non-cancelable own tap', () => {
        expect(runTap({ cancelable: false })).toEqual({
            handled: true,
            calls: ['stop-propagation', 'dispatch-focus'],
        });
    });
});

const run = (s: TermFocusState, e: TermFocusEvent) => reduceTermFocus(s, e);

describe('termFocusPolicy', () => {
    describe('tap (per-key mode)', () => {
        it('focuses the terminal and clears a prior dismissal', () => {
            const { state, action } = run(S({ dismissed: true }), { type: 'tap' });
            expect(action).toBe('focus-terminal');
            expect(state.dismissed).toBe(false);
        });

        it('is the historical desktop/normal behavior from the initial state', () => {
            const { state, action } = run(S(), { type: 'tap' });
            expect(action).toBe('focus-terminal');
            expect(state).toEqual(S());
        });
    });

    describe('tap (special modes)', () => {
        it('does nothing in select mode (gesture belongs to OS selection)', () => {
            const { action } = run(S({ selectMode: true }), { type: 'tap' });
            expect(action).toBe('none');
        });

        it('blurs the input bar in bar mode (tap terminal = put keyboard away)', () => {
            const { state, action } = run(S({ barMode: true }), { type: 'tap' });
            expect(action).toBe('blur-input-bar');
            expect(state.barMode).toBe(true); // mode itself is sticky
        });
    });

    describe('dismiss key', () => {
        it('blurs everything and records the dismissal', () => {
            const { state, action } = run(S(), { type: 'dismiss-key' });
            expect(action).toBe('blur-all');
            expect(state.dismissed).toBe(true);
        });

        it('also works in bar mode (blur-all covers the input bar)', () => {
            const { action } = run(S({ barMode: true }), { type: 'dismiss-key' });
            expect(action).toBe('blur-all');
        });
    });

    describe('bar-key (assistive key bar pty keys)', () => {
        it('never summons the keyboard; the button preserves an already-focused input itself', () => {
            const { action } = run(S(), { type: 'bar-key' });
            expect(action).toBe('none');
        });

        it('does NOT re-open the keyboard after an explicit dismissal — the core fix', () => {
            const { state, action } = run(S({ dismissed: true }), { type: 'bar-key' });
            expect(action).toBe('none');
            expect(state.dismissed).toBe(true); // still dismissed until a tap
        });

        it('never steals the input bar focus in bar mode', () => {
            const { action } = run(S({ barMode: true }), { type: 'bar-key' });
            expect(action).toBe('none');
        });
    });

    describe('focus-settled (post-focusout probe)', () => {
        it('target none → dismissal + layout restore (2nd restore channel)', () => {
            const { state, action } = run(S(), { type: 'focus-settled', target: 'none' });
            expect(action).toBe('restore-layout');
            expect(state.dismissed).toBe(true);
        });

        it('target terminal → no-op (focus bounced back)', () => {
            const { state, action } = run(S(), { type: 'focus-settled', target: 'terminal' });
            expect(action).toBe('none');
            expect(state.dismissed).toBe(false);
        });

        it('target input-bar → no-op (keyboard is still up, owned by the bar)', () => {
            const { action } = run(S({ barMode: true }), { type: 'focus-settled', target: 'input-bar' });
            expect(action).toBe('none');
        });
    });

    describe('snippet insertion', () => {
        it('writes without treating a menu action as consent to raise the keyboard', () => {
            const { state, action } = run(S({ dismissed: true }), { type: 'snippet' });
            expect(action).toBe('none');
            expect(state.dismissed).toBe(true);
        });

        it('leaves focus alone in bar mode', () => {
            const { action } = run(S({ barMode: true }), { type: 'snippet' });
            expect(action).toBe('none');
        });
    });

    describe('bar mode toggle', () => {
        it('entering focuses the input bar', () => {
            const { state, action } = run(S(), { type: 'toggle-bar-mode' });
            expect(state.barMode).toBe(true);
            expect(action).toBe('focus-input-bar');
        });

        it('leaving focuses the terminal and clears dismissal', () => {
            const { state, action } = run(S({ barMode: true, dismissed: true }), { type: 'toggle-bar-mode' });
            expect(state.barMode).toBe(false);
            expect(state.dismissed).toBe(false);
            expect(action).toBe('focus-terminal');
        });
    });

    describe('explicit keyboard control', () => {
        it('shows the active per-key input surface', () => {
            const { state, action } = run(S({ dismissed: true }), { type: 'show-keyboard' });
            expect(state.dismissed).toBe(false);
            expect(action).toBe('focus-terminal');
        });

        it('shows the line-input bar in bar mode and stays inert in select mode', () => {
            expect(run(S({ barMode: true, dismissed: true }), { type: 'show-keyboard' }).action)
                .toBe('focus-input-bar');
            expect(run(S({ selectMode: true, dismissed: true }), { type: 'show-keyboard' }).action)
                .toBe('none');
        });
    });

    describe('select mode', () => {
        it('entering blurs everything (keyboard down for OS selection)', () => {
            const { state, action } = run(S(), { type: 'select-mode', on: true });
            expect(state.selectMode).toBe(true);
            expect(state.dismissed).toBe(true);
            expect(action).toBe('blur-all');
        });

        it('leaving keeps the keyboard down in per-key mode', () => {
            const { state, action } = run(S({ selectMode: true, dismissed: true }), { type: 'select-mode', on: false });
            expect(state.selectMode).toBe(false);
            expect(state.dismissed).toBe(true);
            expect(action).toBe('none');
        });

        it('leaving does not reopen the input bar keyboard when bar mode is on', () => {
            const { action } = run(S({ selectMode: true, barMode: true }), { type: 'select-mode', on: false });
            expect(action).toBe('none');
        });
    });

    describe('full user journeys', () => {
        it('dismiss → arrow keys stay quiet → tap re-opens → keys preserve without refocusing', () => {
            let s = S();
            let r = run(s, { type: 'dismiss-key' });
            expect(r.action).toBe('blur-all');
            r = run(r.state, { type: 'focus-settled', target: 'none' });
            expect(r.action).toBe('restore-layout');
            r = run(r.state, { type: 'bar-key' });
            expect(r.action).toBe('none'); // arrows navigate TUI, keyboard stays down
            r = run(r.state, { type: 'tap' });
            expect(r.action).toBe('focus-terminal');
            r = run(r.state, { type: 'bar-key' });
            expect(r.action).toBe('none'); // the key itself never changes focus
        });

        it('OS-level dismissal (Done key) is honored: focusout none → no auto-refocus', () => {
            let r = run(S(), { type: 'focus-settled', target: 'none' });
            expect(r.state.dismissed).toBe(true);
            r = run(r.state, { type: 'bar-key' });
            expect(r.action).toBe('none');
        });

        it('bar mode: toggle in → keys direct to pty without stealing focus → tap collapses → toggle out', () => {
            let r = run(S(), { type: 'toggle-bar-mode' });
            expect(r.action).toBe('focus-input-bar');
            r = run(r.state, { type: 'bar-key' });
            expect(r.action).toBe('none');
            r = run(r.state, { type: 'tap' });
            expect(r.action).toBe('blur-input-bar');
            r = run(r.state, { type: 'toggle-bar-mode' });
            expect(r.action).toBe('focus-terminal');
            expect(r.state.barMode).toBe(false);
        });
    });
});
