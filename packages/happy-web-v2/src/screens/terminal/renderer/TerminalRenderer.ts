/**
 * Renderer abstraction for the web terminal.
 *
 * WHY: the daemon-authoritative core (subscribe / snapshot / seq / encryption /
 * input) is renderer-independent — it just feeds bytes to *something* that draws
 * a terminal and emits keystrokes. Today that something is xterm.js (DOM
 * renderer). ghostty-web (as of 2026-08) exposes an xterm.js-compatible API
 * (write/reset/resize/onData/onKey/focus/selection/buffer/element + ITerminalAddon
 * addons) with Canvas 60fps + text-selection + clipboard, and Restty adds WebGPU
 * on the same libghostty-vt core. This seam lets a future ghostty/Restty renderer
 * slot in behind a flag without touching the protocol/core, and lets us A/B
 * without betting prod on an immature 0.x.
 *
 * SCOPE: this interface covers the renderer-AGNOSTIC core that both xterm and
 * ghostty expose the same way. The renderer-SPECIFIC bits (xterm's DOM hacks —
 * the `.xterm-helper-textarea` IME/focus dance, synthetic-wheel scroll via
 * `.xterm-screen`, private `_core` font re-measure, FitAddon) are reached today
 * through `raw`. A canvas renderer (ghostty) would re-solve those against its own
 * surface; migrating them off `raw` onto explicit interface methods is the next
 * stage, done per-capability so each is verifiable.
 */
import type { Terminal as XtermTerminal } from '@xterm/xterm';

export interface RendererDisposable {
    dispose(): void;
}

export interface TerminalRenderer {
    /** Live column/row counts (post-fit). */
    readonly cols: number;
    readonly rows: number;
    /** The host element the renderer mounted into (for event wiring / geometry). */
    readonly element: HTMLElement | undefined;

    /** Write raw bytes (pty output) or a control string to the screen. */
    write(data: Uint8Array | string): void;
    /** Write a line (CRLF-terminated) — used for local status/error lines. */
    writeln(data: string): void;
    /** Clear the screen + scrollback (snapshot restore does reset()+write()). */
    reset(): void;
    /** Re-measure the container and resize cols/rows to fit it. */
    fit(): void;

    /** Keystrokes the user typed (already VT-encoded) → send to the pty. */
    onData(cb: (data: string) => void): RendererDisposable;
    /** Raw key events (for the first-command auto-title heuristic). */
    onKey(cb: (e: { key: string; domEvent: KeyboardEvent }) => void): RendererDisposable;

    /** Insert text at the cursor via bracketed paste (never auto-executes). */
    paste(data: string): void;
    focus(): void;
    blur(): void;
    hasSelection(): boolean;
    getSelection(): string;

    dispose(): void;

    /**
     * Escape hatch to the underlying xterm.js Terminal. Used ONLY by the
     * renderer-specific DOM code still living in the screen (IME/focus textarea,
     * synthetic-wheel scroll target, private font re-measure). Null on renderers
     * without an xterm instance — such code must branch or move behind explicit
     * interface methods before a non-xterm renderer ships.
     */
    readonly raw: XtermTerminal | null;
}

export type RendererKind = 'xterm';

export interface RendererOptions {
    mount: HTMLElement;
    fontFamily: string;
    fontSize: number;
    theme: Record<string, string>;
    scrollback: number;
    coarsePointer: boolean;
}
