import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * T-013 (CPU audit): `.vh-dot--pulse` used to animate `box-shadow`, which is
 * not a compositor property — every visible pulsing dot forced a main-thread
 * style recalc + paint + layerize + commit on EVERY frame (real-CSS trace in
 * Chromium, 12 dots / 8s: 961 Paint + 961 UpdateLayoutTree + 10 897 raster
 * tasks ≈ 6.4% of the main thread; after: 0 Paint, 53 UpdateLayoutTree,
 * ≈ 0.24%). The header "connected" dot pulses for the whole life of a session
 * tab, so this ran permanently on every foreground tab.
 *
 * Rule pinned here: the pulse keyframes may only animate `opacity` and
 * `transform`. The glow ring lives on ::after with a STATIC shadow and moves
 * via scale/opacity. Animate box-shadow again and this goes red.
 */
const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

function keyframes(name: string): string {
    const m = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!m) throw new Error(`@keyframes ${name} not found`);
    return m[1]!;
}

describe('StatusDot pulse stays on the compositor', () => {
    it('vh-dot-pulse animates opacity only', () => {
        const body = keyframes('vh-dot-pulse');
        expect(body).toMatch(/opacity:/);
        expect(body).not.toMatch(/box-shadow|background|width|height|border/);
    });

    it('vh-dot-ring animates transform + opacity only', () => {
        const body = keyframes('vh-dot-ring');
        expect(body).toMatch(/transform:\s*scale\(/);
        expect(body).toMatch(/opacity:/);
        expect(body).not.toMatch(/box-shadow|background|width|height|border/);
    });

    it('the ring is the ::after pseudo with a static shadow and inherits the stagger delay', () => {
        const ring = css.match(/\.vh-dot--pulse::after\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
        expect(ring).toMatch(/box-shadow:\s*0 0 0 4px var\(--accent-glow\)/);
        expect(ring).toMatch(/animation:\s*vh-dot-ring/);
        // StatusDot sets the per-dot phase as inline animation-delay on the
        // element; the ring must follow it or dots and rings drift apart.
        expect(ring).toMatch(/animation-delay:\s*inherit/);
    });

    it('reduced motion disables both layers', () => {
        const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]!);
        expect(blocks.some((b) => /\.vh-dot--pulse,\s*\.vh-dot--pulse::after\s*\{\s*animation:\s*none/.test(b))).toBe(true);
    });
});
