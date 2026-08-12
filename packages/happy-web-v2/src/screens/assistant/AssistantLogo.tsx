/**
 * AssistantLogo — the central status mark of the voice assistant.
 *
 * STRUCTURE CONTRACT (merge coordination): this is a state-animation SHELL
 * with a replaceable center glyph. The four state animations (idle breath /
 * listening level ring / thinking arc / speaking bars) live entirely on the
 * container + ring layers; the center is a `glyph` slot that defaults to a
 * simple placeholder SVG. The brand mark (CyberMark) gets inserted into the
 * slot at merge time — do not fuse animations into the glyph.
 *
 * Color discipline: --accent strictly means live (listening / speaking);
 * idle and thinking stay on --text-faint / --text-dim. All animation is pure
 * CSS/SVG (assistant.css); prefers-reduced-motion degrades to opacity fades.
 * The listening ring reads the CSS var `--as-level` (0..1 mic level) set by
 * the screen on a parent element.
 */

import type { ReactNode } from 'react';

export type AssistantLogoState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Placeholder center glyph — swapped for the brand mark at merge time. */
function PlaceholderGlyph({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {/* terminal-window outline */}
            <rect x="6" y="9" width="36" height="30" rx="5" />
            <path d="M14 20l6 5-6 5" />
            <path d="M24 30h10" />
        </svg>
    );
}

export function AssistantLogo({
    state,
    glyph,
    size = 148,
}: {
    state: AssistantLogoState;
    /** replaceable center mark; defaults to the placeholder SVG */
    glyph?: ReactNode;
    size?: number;
}) {
    return (
        <div className="as-logo" data-state={state} style={{ width: size, height: size }}>
            {/* idle: breathing glow */}
            <div className="as-logo-halo" />
            {/* listening: accent ring scaled by mic level (--as-level) */}
            <div className="as-logo-wave" />
            <div className="as-logo-wave as-logo-wave--outer" />
            {/* thinking: rotating thin arc */}
            <svg className="as-logo-arc" viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r="46" fill="none" strokeWidth="2" pathLength="100" />
            </svg>
            {/* speaking: waveform bars below the glyph */}
            <div className="as-logo-bars" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
            </div>
            <div className="as-logo-glyph">{glyph ?? <PlaceholderGlyph size={Math.round(size * 0.34)} />}</div>
        </div>
    );
}
