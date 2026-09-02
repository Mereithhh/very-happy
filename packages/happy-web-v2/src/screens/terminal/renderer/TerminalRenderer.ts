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
    /**
     * What `fit()` WOULD resize to, without doing it (B-124). In the v2 lines
     * channel the client wraps lines itself, so its width must change exactly
     * where the pane's did — the screen therefore PROPOSES a size to the daemon
     * and adopts the authoritative one when it arrives in-band, instead of
     * re-wrapping the moment the container moved.
     */
    proposeFit(): { cols: number; rows: number } | undefined;
    /** Adopt an authoritative geometry (pane size) without re-measuring. */
    resizeTo(cols: number, rows: number): void;
    /** Re-measure the glyph cell size from the CURRENTLY loaded font (B-289).
     *  The web monospace face loads async; call this once it is ready so the
     *  next `fit()` computes columns from the real advance width, not a
     *  fallback font's. Encapsulates the renderer's private char-size service. */
    remeasureFont(): void;

    /** Keystrokes the user typed (already VT-encoded) → send to the pty. */
    onData(cb: (data: string) => void): RendererDisposable;
    /** Raw key events (for the first-command auto-title heuristic). */
    onKey(cb: (e: { key: string; domEvent: KeyboardEvent }) => void): RendererDisposable;

    /** Insert text at the cursor via bracketed paste (never auto-executes). */
    paste(data: string): void;
    /** @deprecated alias of {@link focusInput} — kept so no call site can miss the seam. */
    focus(): void;
    /** @deprecated alias of {@link blurInput}. */
    blur(): void;
    hasSelection(): boolean;
    getSelection(): string;

    // ── Keyboard-input seam (spec: 2026-08-terminal-input-ownership §A/§D) ──
    // "The terminal has keyboard focus" used to mean exactly one thing —
    // xterm's `.xterm-helper-textarea` — and the 8 places that needed to say it
    // each reached for that class name themselves. The input-ownership rework
    // adds a SECOND possible input element (our own `.vh-term-input` overlay),
    // so the question moves behind this seam instead of becoming 8 forks.
    // `focus()`/`blur()` above delegate here, so even a missed call site is
    // correct — the historical failure mode was always "one place forgot".

    /** The element that owns keyboard focus for this terminal right now. */
    inputElement(): HTMLElement | null;
    /**
     * Point the seam at our own input element (input-ownership 'own' mode);
     * null restores xterm's helper textarea. Called by the screen after it
     * installs the overlay — the overlay itself needs the pty writer and the
     * device policy, which the renderer knows nothing about.
     */
    setInputElement(el: HTMLElement | null): void;
    focusInput(): void;
    blurInput(): void;
    isInputFocused(): boolean;
    /** Inner TUI requested mouse reports, even if the renderer filters them. */
    sgrWheelRequested(): boolean;
    /**
     * Re-emit a real keydown as a SYNTHETIC one against the renderer's own key
     * handling, so its VT encoder (DECCKM, application keypad, modifier
     * parameters, F-keys) stays the single source of truth — we deliberately
     * do NOT hand-roll an encoding table in phase 1 (spec §D).
     *
     * Implementations must dispatch a keydown ONLY — never a keyup: xterm's
     * `_keyUp` calls `this.focus()`, which would steal the keyboard back from
     * the overlay and leave typing dead.
     */
    sendKey(ev: KeyboardEvent): void;

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
