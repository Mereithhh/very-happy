/**
 * xterm.js implementation of TerminalRenderer (DOM renderer). This is the only
 * renderer today; the factory picks it. A ghostty/Restty renderer would be a
 * sibling file implementing the same interface.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { installMouseModeFilter } from '../termMouseModeFilter';
import type { TerminalRenderer, RendererOptions } from './TerminalRenderer';

export function createXtermRenderer(opts: RendererOptions): TerminalRenderer {
    const term = new Terminal({
        fontFamily: opts.fontFamily,
        fontSize: opts.fontSize,
        // lineHeight 1.0 — pixel-art/block glyphs (the Claude startup logo) and
        // TUI box-drawing must tile SEAMLESSLY, and the DOM renderer draws those
        // from the font (no customGlyphs — that's canvas/webgl only). Any
        // lineHeight > 1 inserts leading between the stacked block rows
        // (xterm DomRenderer cell.height = floor(charHeight * lineHeight)), so
        // 1.3 opened a ~30% dark seam through the logo (xterm.js #2572). 1.0 is
        // the standard console density and the only value that closes the seam
        // in the DOM renderer without a WebGL migration. See
        // specs/2026-09-terminal-render-integrity.md.
        lineHeight: 1.0,
        cursorBlink: true,
        theme: opts.theme,
        allowProposedApi: true,
        convertEol: false,
        scrollback: opts.scrollback,
        // Mac: Shift-drag does nothing while an app holds the mouse (xterm forces
        // local selection on Shift only off-Mac); Option-drag is the Mac gesture,
        // but only when this is on. Lets Mac users select/copy even if an inner
        // TUI (or a lingering mouse mode) is grabbing the mouse.
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    // OSC 52 → system clipboard. tmux copy-mode yank (set-clipboard on) and apps
    // like Claude Code emit OSC 52; without this addon xterm silently drops it.
    // Write-only by default (no clipboard READ → no exfiltration).
    term.loadAddon(new ClipboardAddon());
    // Unicode 11 widths: fixes CJK / emoji / box-drawing column alignment in the
    // Claude Code TUI (needs allowProposedApi, already set, + activeVersion).
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    // Swallow the inner TUI's DECSET mouse-tracking requests (Claude Code's
    // TUI enables mouse reporting; tmux `mouse off` passes it through) —
    // otherwise xterm hands the mouse to the app and NATIVE SELECTION DIES
    // ("drag does nothing"). See termMouseModeFilter.ts for the mechanism.
    const mouseFilter = installMouseModeFilter(term);
    term.open(opts.mount);

    // Input-ownership seam (see TerminalRenderer's "Keyboard-input seam"):
    // null = xterm's own helper textarea (today's path); set to our overlay by
    // the screen when `terminalInputOwnership === 'own'`. Queried live rather
    // than cached because the renderer can rebuild its textarea.
    let ownInput: HTMLElement | null = null;
    const inputElement = (): HTMLElement | null => ownInput ?? term.textarea ?? null;
    const focusInput = () => {
        const el = inputElement();
        if (el === term.textarea) term.focus(); // xterm path: keep its own bookkeeping
        else el?.focus({ preventScroll: true });
    };

    return {
        get cols() { return term.cols; },
        get rows() { return term.rows; },
        get element() { return term.element ?? undefined; },
        write: (data) => term.write(data),
        writeln: (data) => term.writeln(data),
        reset: () => term.reset(),
        fit: () => { try { fit.fit(); } catch { /* not laid out yet */ } },
        proposeFit: () => { try { return fit.proposeDimensions(); } catch { return undefined; } },
        resizeTo: (cols, rows) => {
            try { term.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows))); } catch { /* invalid dims */ }
        },
        remeasureFont: () => {
            // Private API (no public seam in the pinned xterm): re-run the char
            // measurement so a font that loaded AFTER open() updates the cell
            // size. Best-effort — a version bump that renames this is caught by
            // the fonts.ready belt still calling fit().
            try { (term as unknown as { _core?: { _charSizeService?: { measure?: () => void } } })._core?._charSizeService?.measure?.(); } catch { /* best-effort */ }
        },
        onData: (cb) => term.onData(cb),
        onKey: (cb) => term.onKey(cb),
        paste: (data) => term.paste(data),
        focus: focusInput,
        blur: () => { const el = inputElement(); if (el === term.textarea) term.blur(); else el?.blur(); },
        hasSelection: () => term.hasSelection(),
        getSelection: () => term.getSelection(),
        inputElement,
        setInputElement: (el) => { ownInput = el; },
        focusInput,
        blurInput: () => { const el = inputElement(); if (el === term.textarea) term.blur(); else el?.blur(); },
        isInputFocused: () => {
            const el = inputElement();
            return el != null && typeof document !== 'undefined' && document.activeElement === el;
        },
        sgrWheelRequested: () => mouseFilter.sgrWheelRequested(),
        // Synthetic keydown against xterm's own textarea → its `_keyDown` runs
        // the full encoder (DECCKM / application keypad / modifier params /
        // F-keys / macOptionIsMeta / scrollOnUserInput) and the bytes land on
        // `term.onData` → the screen's single `sendInput` chokepoint.
        //
        // KEYDOWN ONLY (spec §D discipline 1): `_keyUp` calls `this.focus()`.
        // `bubbles:false` keeps the synthetic event out of the bubble phase —
        // the app's window-CAPTURE shortcuts still see it (capture always runs)
        // but they are stateless predicates that already declined the real
        // event one tick earlier, so a second pass decides the same way.
        //
        // The legacy `keyCode`/`which` members are NOT in TS's
        // KeyboardEventInit but every engine honours them — and xterm's
        // `evaluateKeyboardEvent` reads `ev.keyCode` for most of its table, so
        // they are load-bearing, not cosmetic.
        sendKey: (ev) => {
            const ta = term.textarea;
            if (!ta) return;
            ta.dispatchEvent(new KeyboardEvent('keydown', {
                key: ev.key,
                code: ev.code,
                location: ev.location,
                repeat: ev.repeat,
                ctrlKey: ev.ctrlKey,
                altKey: ev.altKey,
                shiftKey: ev.shiftKey,
                metaKey: ev.metaKey,
                bubbles: false,
                cancelable: true,
                composed: true,
                keyCode: ev.keyCode,
                which: ev.keyCode,
            } as KeyboardEventInit));
        },
        dispose: () => { mouseFilter.dispose(); term.dispose(); },
        raw: term,
    };
}
