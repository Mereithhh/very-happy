/**
 * Unit tests for the keyboard-viewport stabilizer + layout math.
 *
 * Regression anchor (2026-08-13): first keyboard open on iOS judders — the
 * open is an animation, visualViewport fires resize on many frames, and every
 * frame used to run maxHeight → ResizeObserver → refit → terminal-resize RPC
 * → tmux reflow. The stabilizer must collapse a whole animation burst into
 * exactly ONE stable callback (= one fit + one RPC), while per-frame CSS
 * follows the keyboard outside this module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    MOBILE_TYPO_BASE,
    computeKbAvail,
    createViewportStabilizer,
    typographyChangesCols,
} from './termKbViewport';
import { TERM_FONT_SIZE_COARSE, TERM_LINE_HEIGHT } from './termFont';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('createViewportStabilizer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const make = (onStable: (h: number) => void, opts?: { quietMs?: number; maxWaitMs?: number }) =>
        createViewportStabilizer({ onStable, quietMs: 120, maxWaitMs: 600, ...opts });

    it('collapses an iOS keyboard-open animation burst into ONE stable callback', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        // ~8 animation frames of a 250ms keyboard slide, height shrinking each frame
        const frames = [800, 760, 700, 640, 580, 530, 500, 490];
        for (const h of frames) {
            s.sample(h);
            expect(s.pending()).toBe(true);
            vi.advanceTimersByTime(16);
        }
        expect(onStable).not.toHaveBeenCalled(); // still animating
        vi.advanceTimersByTime(120); // quiet period after the last change
        expect(onStable).toHaveBeenCalledTimes(1);
        expect(onStable).toHaveBeenCalledWith(490); // the FINAL height
        expect(s.pending()).toBe(false);
    });

    it('fires quietMs after the LAST CHANGE, not the first sample', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(700);
        vi.advanceTimersByTime(100); // < quietMs, then the height moves again
        s.sample(500);
        vi.advanceTimersByTime(110);
        expect(onStable).not.toHaveBeenCalled(); // timer restarted at the change
        vi.advanceTimersByTime(10);
        expect(onStable).toHaveBeenCalledWith(500);
    });

    it('repeated UNCHANGED samples (vv scroll echoes) do not restart the quiet timer', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(500);
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(20);
            s.sample(500); // same height — must not defer
        }
        vi.advanceTimersByTime(20); // total 120ms since the one real change
        expect(onStable).toHaveBeenCalledTimes(1);
    });

    it('hard cap: a never-quiet stream still fires by maxWaitMs from burst start', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        let h = 800;
        s.sample(h);
        // height keeps changing every 50ms — quiet period never elapses
        for (let t = 0; t < 700; t += 50) {
            vi.advanceTimersByTime(50);
            h -= 5;
            s.sample(h);
        }
        expect(onStable).toHaveBeenCalledTimes(1); // fired at the 600ms cap
        // and the value is whatever the height was when the cap hit
        expect(onStable.mock.calls[0][0]).toBeLessThan(800);
    });

    it('cancel() drops the burst without firing (restore path takes over)', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(500);
        s.cancel();
        expect(s.pending()).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(onStable).not.toHaveBeenCalled();
    });

    it('a new burst after firing works independently (second keyboard open)', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(500);
        vi.advanceTimersByTime(120);
        expect(onStable).toHaveBeenCalledTimes(1);
        s.sample(800); // keyboard closes/opens again
        s.sample(490);
        vi.advanceTimersByTime(120);
        expect(onStable).toHaveBeenCalledTimes(2);
        expect(onStable).toHaveBeenLastCalledWith(490);
    });
});

describe('computeKbAvail', () => {
    it('visible viewport minus host top, bars, and margin', () => {
        // iPhone-ish: vv 852→490 with keyboard, header puts hostTop at 56,
        // bars 46px, default 8px margin
        expect(computeKbAvail({ vvHeight: 490, vvOffsetTop: 0, hostTop: 56, barsHeight: 46 }))
            .toBe(490 - 56 - 46 - 8);
    });
    it('accounts for the iOS layout-viewport pan via vvOffsetTop', () => {
        expect(computeKbAvail({ vvHeight: 490, vvOffsetTop: 30, hostTop: 56, barsHeight: 46 }))
            .toBe(30 + 490 - 56 - 46 - 8);
    });
    it('honours a custom margin', () => {
        expect(computeKbAvail({ vvHeight: 400, vvOffsetTop: 0, hostTop: 50, barsHeight: 40, marginPx: 0 }))
            .toBe(310);
    });
});

/**
 * T-006 regression anchor (2026-09): "Claude Code logo wraps / shows twice on
 * the phone". The daemon runs claude on the classic renderer
 * (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1), so its startup header is static
 * history: any COLUMN change after launch makes claude reprint the header and
 * tmux hard-wrap every history line wider than the new width (verified with
 * real claude 2.1.263: 62x37 → 57x42 reproduces, 62x37 → 62x42 does not).
 * The soft keyboard used to change columns on every open/close because the
 * keyboard-state typography dropped 12px → 11px (cell 7.2px → 6.6px). It also
 * wrote lineHeight 1.3 back over the renderer's 1.0 (#161), reopening the
 * logo seam. The keyboard may only ever change ROWS.
 */
describe('keyboard state never changes cell metrics (T-006)', () => {
    it('the one mobile typography IS the renderer\'s coarse open state', () => {
        expect(MOBILE_TYPO_BASE).toEqual({ fontSize: TERM_FONT_SIZE_COARSE, lineHeight: TERM_LINE_HEIGHT });
    });

    it('lineHeight is the seamless value (#161) — 1.3/1.25 must never come back', () => {
        expect(TERM_LINE_HEIGHT).toBe(1);
        expect(MOBILE_TYPO_BASE.lineHeight).toBe(1);
    });

    it('a 12→11px swap would have changed the column count on every real phone width', () => {
        // .term-host inner width = viewport - 16px padding (<600px); the historical
        // compact typography was 11px. Every phone from 320 to 430px flips columns.
        const compact = { fontSize: 11, lineHeight: 1 };
        for (const vw of [320, 360, 375, 390, 412, 430]) {
            expect(typographyChangesCols(vw - 16, MOBILE_TYPO_BASE, compact)).toBe(true);
        }
        // …and the same typography never does, by construction.
        for (const vw of [320, 360, 375, 390, 412, 430]) {
            expect(typographyChangesCols(vw - 16, MOBILE_TYPO_BASE, MOBILE_TYPO_BASE)).toBe(false);
        }
    });

    it('the owner\'s phone: 430px → 57 cols at 12px, 62 at 11px (the live pane sat at 62x37)', () => {
        const cols = (fs: number) => Math.floor((430 - 16) / (fs * 0.6));
        expect(cols(12)).toBe(57);
        expect(cols(11)).toBe(62);
    });

    it('WebTerminalScreen never rewrites term.options.fontSize / lineHeight (keyboard path removed)', () => {
        const screen = src('WebTerminalScreen.tsx');
        expect(screen).not.toMatch(/term\.options\.fontSize\s*=/);
        expect(screen).not.toMatch(/term\.options\.lineHeight\s*=/);
        expect(screen).not.toContain('applyTypography');
        expect(screen).not.toContain('pickTermTypography');
        // and the module no longer offers a second typography to apply
        const kb = src('termKbViewport.ts');
        expect(kb).not.toContain('MOBILE_TYPO_COMPACT');
        expect(kb).not.toContain('COMPACT_VV_HEIGHT_PX');
    });

    it('the renderer opens with the SAME shared lineHeight constant (no literal to drift)', () => {
        const renderer = src('renderer/xtermRenderer.ts');
        expect(renderer).toContain('lineHeight: TERM_LINE_HEIGHT');
        expect(renderer).not.toMatch(/lineHeight:\s*1\.[0-9]/);
    });
});
