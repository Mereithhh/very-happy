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
import '@xterm/xterm/css/xterm.css';
import { apiSocket } from '@/sync/apiSocket';
import { machineOpenTerminal } from '@/sync/ops';
import { useTerminalSessions } from '@/sync/terminalSessions';

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
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);
        try { fit.fit(); } catch { /* container not laid out yet */ }

        let terminalId: string | null = null;
        let disposed = false;
        const cleanups: Array<() => void> = [];

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

            // Auto-title from the first command the user runs (replaces the
            // default machine-name once; a manual rename always wins).
            let titled = false;
            let lineBuf = '';
            const offData = term.onData((d) => {
                if (terminalId) apiSocket.send('terminal-input', { machineId, terminalId, data: toBase64(d) });
                if (titled || !tid) return;
                for (const ch of d) {
                    if (ch === '\r' || ch === '\n') {
                        const cmd = lineBuf.trim();
                        lineBuf = '';
                        if (cmd) { useTerminalSessions.getState().autoTitle(tid, cmd); titled = true; break; }
                    } else if (ch === '\x7f' || ch === '\b') {
                        lineBuf = lineBuf.slice(0, -1);
                    } else if (ch >= ' ') {
                        lineBuf += ch;
                    }
                }
            });
            cleanups.push(() => offData.dispose());

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
        <View style={{ flex: 1, backgroundColor: BG }}>
            {/* @ts-ignore web-only DOM host */}
            <div ref={hostRef} style={{ flex: 1, width: '100%', height: '100%', padding: 8, boxSizing: 'border-box' }} />
        </View>
    );
}
