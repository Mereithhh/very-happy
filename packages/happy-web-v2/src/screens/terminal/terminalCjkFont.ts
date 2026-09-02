// Lazy CJK terminal font (Sarasa Fixed SC), 2026-09.
//
// The terminal font must be DUAL-WIDTH: a CJK ideograph advance exactly 2x the
// ASCII advance, or Chinese overlaps the xterm grid (叠字). IBM Plex Mono (the
// Latin terminal font) has ZERO CJK, so the browser substitutes an OS Han face
// whose advance != 2x the cell → overlap. Sarasa Fixed SC (Iosevka Latin fused
// to Source Han Sans SC at a locked 2:1) fixes it — and, as a bonus, its
// Iosevka block/box glyphs FILL the cell, so it also makes the Claude logo /
// TUI frames tile seamlessly in the DOM renderer (see the render-integrity spec;
// verified: Sarasa in the plain DOM renderer == the WebGL customGlyphs result).
//
// It is a large font, so it is NOT bundled: the full set is sliced by
// unicode-range (cn-font-split) and self-hosted on Cloudflare Pages, and the
// browser fetches only the slices for codepoints it actually paints. We inject
// the @font-face stylesheets on demand — the FIRST time a terminal opens — so
// nothing loads for users who never open a terminal, and the main bundle is
// untouched. The woff2 are served with `Access-Control-Allow-Origin: *` and
// immutable caching; the stylesheet's own @font-face `src` urls are relative,
// so they resolve against the CDN. very-happy sets no CSP, so no allowlist edit
// is needed. xterm measures the cell from the ASCII glyph and Sarasa's Han is
// 2x by construction, so a not-yet-fetched rare-Han slice only causes a brief
// tofu on that glyph's first paint, never a misaligned grid.

const CJK_FONT_BASE = 'https://veryhappy-fonts.pages.dev';
const CJK_FONT_STYLE_ID = 'vh-terminal-cjk-font';

/** The family to put FIRST in the terminal fontFamily stack. */
export const TERMINAL_CJK_FONT_FAMILY = 'Sarasa Fixed SC';

/** Pure: the stylesheet links to inject (Regular 400 + Bold 700), CDN-hosted.
 *  Kept separate so the URL construction is unit-testable without a DOM. */
export function terminalCjkFontLinks(): ReadonlyArray<{ weight: 'regular' | 'bold'; href: string }> {
    return (['regular', 'bold'] as const).map((weight) => ({
        weight,
        href: `${CJK_FONT_BASE}/${weight}/result.css`,
    }));
}

let injected = false;

/**
 * Inject the Sarasa Fixed SC @font-face stylesheets (Regular 400 + Bold 700)
 * once. Idempotent and SSR-safe; a no-op after the first call or without a DOM.
 * Call it when a terminal mounts so the CJK font is a deferred, terminal-only
 * asset. The existing `document.fonts.ready` hook re-measures xterm once the
 * faces settle, so callers need do nothing else.
 */
export function ensureTerminalCjkFont(): void {
    if (injected || typeof document === 'undefined') return;
    injected = true;
    for (const { weight, href } of terminalCjkFontLinks()) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.vhFont = `${CJK_FONT_STYLE_ID}-${weight}`;
        document.head.appendChild(link);
    }
}
