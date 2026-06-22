/**
 * Web terminal screen (web only). Hosts xterm.js bound to a tmux+pty session
 * on the selected machine via the socket relay. Responsive: a FitAddon +
 * ResizeObserver keep cols/rows matched to the container (mobile + resize),
 * and every fit pushes a terminal-resize to the daemon so tmux follows.
 */
import * as React from 'react';
import { View, Platform } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { apiSocket } from '@/sync/apiSocket';
import { machineOpenTerminal, machineSetTerminalTitle } from '@/sync/ops';

const BG = '#0B0E13';

function toBase64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export default function WebTerminalScreen() {
    const { machineId, tid } = useLocalSearchParams<{ machineId: string; tid?: string }>();
    const hostRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !hostRef.current || !machineId) return;
        const host = hostRef.current;

        const term = new Terminal({
            cursorBlink: true,
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            fontSize: 13,
            theme: { background: BG, foreground: '#E8EDF4', cursor: '#34E2C4', selectionBackground: 'rgba(52,226,196,0.25)' },
            allowProposedApi: true,
            // tmux owns the scrollback (wheel → tmux copy-mode), so xterm needs
            // none. scrollback:0 also makes FitAddon stop reserving a ~17px
            // scrollbar gutter, so the terminal uses the FULL width — otherwise
            // it runs ~2 cols short and tmux clips the right end of its status
            // bar (the trailing date/number).
            scrollback: 0,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        // Unicode 11 width tables: without this xterm measures CJK/emoji with
        // the legacy v6 tables and the cursor advances by the wrong cell count
        // → wide chars overlap. Must be activated before content is written.
        const unicode11 = new Unicode11Addon();
        term.loadAddon(unicode11);
        term.unicode.activeVersion = '11';
        term.open(host);
        try { fit.fit(); } catch { /* container not laid out yet */ }

        let terminalId: string | null = null;
        let disposed = false;
        const cleanups: Array<() => void> = [];

        // Clipboard + right-click UX. tmux mouse-mode is ON (for wheel-scroll),
        // so a plain drag is a tmux selection — on release tmux copies it and,
        // because the daemon enabled set-clipboard + the clipboard terminal
        // feature, emits an OSC 52 escape. We mirror that into the browser
        // clipboard, so a plain drag-select copies with NO modifier needed
        // (the highlight clears on release — that's tmux — but the text is
        // copied). A Shift+drag instead makes a native xterm selection that
        // keeps the highlight; we auto-copy that too.
        const writeClipboard = (text: string) => {
            try { void navigator.clipboard?.writeText(text); } catch { /* blocked by browser policy */ }
        };
        const offOsc = term.parser.registerOscHandler(52, (payload) => {
            const b64 = payload.split(';').pop();
            // Cap size: a program in the shell can emit OSC 52 to set the
            // clipboard (standard terminal behavior, and how our drag-copy
            // works), but bound it so it can't dump megabytes into the clipboard.
            if (b64 && b64 !== '?' && b64.length <= 128 * 1024) {
                try {
                    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                    writeClipboard(new TextDecoder().decode(bytes)); // UTF-8 → handles CJK
                } catch { /* malformed */ }
            }
            return true;
        });
        cleanups.push(() => offOsc.dispose());
        const offSel = term.onSelectionChange(() => {
            const sel = term.getSelection();
            if (sel) writeClipboard(sel);
        });
        cleanups.push(() => offSel.dispose());

        // Right-click pastes (the browser menu is hidden anyway) — a common
        // terminal convention that pairs with drag-to-copy. Route through
        // term.paste() (not a raw terminal-input send) so it goes through
        // xterm's bracketed-paste handling: a clipboard payload containing
        // newlines is delivered as pasted text, NOT auto-executed as commands.
        const onCtx = (e: MouseEvent) => {
            e.preventDefault();
            navigator.clipboard?.readText?.().then((text) => {
                if (text) term.paste(text);
            }).catch(() => { /* clipboard read blocked / denied */ });
        };
        host.addEventListener('contextmenu', onCtx);
        cleanups.push(() => host.removeEventListener('contextmenu', onCtx));

        // Mobile: focusing the terminal pops the on-screen keyboard, and the
        // browser scrolls the focused (bottom) textarea into view, hiding the
        // output/context above. Pin the page back to the top on focus so the
        // context stays visible. Coarse-pointer only (real touch devices).
        const isCoarsePointer = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: coarse)').matches;
        if (isCoarsePointer && term.textarea) {
            const ta = term.textarea;
            const onFocus = () => {
                // After the browser's own scroll-into-view settles.
                setTimeout(() => window.scrollTo({ top: 0, left: 0 }), 50);
            };
            ta.addEventListener('focus', onFocus);
            cleanups.push(() => ta.removeEventListener('focus', onFocus));
        }

        term.writeln('\x1b[2m… connecting to ' + machineId + '\x1b[0m');

        (async () => {
            const res = await machineOpenTerminal(machineId, { terminalId: tid, cols: term.cols, rows: term.rows });
            if (disposed) return;
            if (!res.success) {
                term.writeln('\r\n\x1b[31m✗ ' + res.error + '\x1b[0m');
                return;
            }
            terminalId = res.terminalId;

            const offOut = apiSocket.onMessage('terminal-output', (e: { terminalId: string; data: string }) => {
                if (e.terminalId === terminalId) term.write(fromBase64(e.data));
            });
            const offExit = apiSocket.onMessage('terminal-exit', (e: { terminalId: string; exitCode: number }) => {
                if (e.terminalId === terminalId) term.writeln('\r\n\x1b[2m[session ended · exit ' + e.exitCode + ']\x1b[0m');
            });
            cleanups.push(offOut, offExit);

            const offData = term.onData((d) => {
                if (terminalId) apiSocket.send('terminal-input', { machineId, terminalId, data: toBase64(d) });
            });
            cleanups.push(() => offData.dispose());

            // Auto-title from the first command the user runs (replaces the
            // default machine-name once; a manual rename always wins). Driven
            // by onKey, not onData — onData also carries xterm's replies to
            // terminal queries (device-attributes / color), which would
            // otherwise be captured as a garbage "command".
            let titled = false;
            let lineBuf = '';
            const offKey = term.onKey(({ key, domEvent }) => {
                if (titled || !tid) return;
                if (domEvent.key === 'Enter') {
                    const cmd = lineBuf.trim();
                    lineBuf = '';
                    if (cmd) { void machineSetTerminalTitle(machineId, tid, cmd, true); titled = true; }
                } else if (domEvent.key === 'Backspace') {
                    lineBuf = lineBuf.slice(0, -1);
                } else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey && !domEvent.altKey) {
                    lineBuf += key;
                }
            });
            cleanups.push(() => offKey.dispose());

            // push the real size now that the session exists
            apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
            term.focus();
        })();

        const ro = new ResizeObserver(() => {
            try { fit.fit(); } catch { return; }
            if (terminalId) apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
        });
        ro.observe(host);

        return () => {
            disposed = true;
            ro.disconnect();
            if (terminalId) apiSocket.send('terminal-close', { machineId, terminalId });
            cleanups.forEach((c) => c());
            term.dispose();
        };
    }, [machineId, tid]);

    return (
        // minWidth/minHeight:0 + overflow:hidden are load-bearing: a flex item
        // defaults to min-width:auto and won't shrink below its content's
        // intrinsic size. xterm's canvas reports a min-width for its current
        // cols, so without this the host grows WIDER than the viewport, FitAddon
        // then measures that inflated width → too many cols → the line runs off
        // the right edge before wrapping. Clamping the box makes fit see the
        // real visible width and cols match what's on screen.
        // The 8px inset lives on the OUTER View, not the host div: FitAddon
        // measures the host's box to pick rows, and a padding on the host made
        // it overcount by a row → the last line was clipped at the bottom.
        // A padding-free host gives FitAddon a clean box (no off-by-a-row clip).
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', backgroundColor: BG, padding: 8 }}>
            {/* @ts-ignore web-only DOM host */}
            <div ref={hostRef} style={{ flex: 1, width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', boxSizing: 'border-box' }} />
        </View>
    );
}
