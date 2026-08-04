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
import type { TerminalRenderer, RendererOptions } from './TerminalRenderer';

export function createXtermRenderer(opts: RendererOptions): TerminalRenderer {
    const term = new Terminal({
        fontFamily: opts.fontFamily,
        fontSize: opts.fontSize,
        lineHeight: 1.3,
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
    term.open(opts.mount);

    return {
        get cols() { return term.cols; },
        get rows() { return term.rows; },
        get element() { return term.element ?? undefined; },
        write: (data) => term.write(data),
        writeln: (data) => term.writeln(data),
        reset: () => term.reset(),
        fit: () => { try { fit.fit(); } catch { /* not laid out yet */ } },
        onData: (cb) => term.onData(cb),
        onKey: (cb) => term.onKey(cb),
        paste: (data) => term.paste(data),
        focus: () => term.focus(),
        blur: () => term.blur(),
        hasSelection: () => term.hasSelection(),
        getSelection: () => term.getSelection(),
        dispose: () => term.dispose(),
        raw: term,
    };
}
