/**
 * Web terminal screen (web only). Hosts xterm.js bound to a tmux+pty session
 * on the selected machine via the socket relay. Responsive: a FitAddon +
 * ResizeObserver keep cols/rows matched to the container (mobile + resize),
 * and every fit pushes a terminal-resize to the daemon so tmux follows.
 */
import * as React from 'react';
import { View, Platform, Pressable, Text } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { TmuxHelpModal } from '@/components/TmuxHelpModal';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { apiSocket } from '@/sync/apiSocket';
import { machineOpenTerminal, machineSetTerminalTitle, encryptTerminalData, decryptTerminalData, machineUploadFile } from '@/sync/ops';
import { useSetting } from '@/sync/storage';
import { Modal } from '@/modal';
import { SnippetPickerModal } from '@/components/SnippetPickerModal';
import { t } from '@/text';
import { cacheKey, getTerminalEntry, setTerminalEntry, type TerminalCacheEntry } from '@/utils/terminalCache.web';

const BG = '#0B0E13';

// IME (Chinese/Japanese/Korean) composition overlay fix. xterm positions a
// hidden .xterm-helper-textarea at the cursor and, while composing, the OS draws
// the candidate/pinyin string there. The browser default makes that text
// transparent and 1px-wide, so the composing string renders ON TOP of the
// terminal content underneath — overlapping/garbled until you commit. Make the
// composing textarea opaque with the terminal's own colors and let it size to
// the composition so the pinyin sits in a solid box at the cursor instead of
// bleeding over the cells. Scoped to .xterm so it can't touch anything else;
// injected once, web only. Does not affect normal (non-composing) latin input —
// the textarea is still visually 0-opacity until a composition starts (xterm
// toggles .composing on the textarea during IME composition).
let imeStyleInjected = false;
function injectImeCompositionFix() {
    if (imeStyleInjected || typeof document === 'undefined') return;
    imeStyleInjected = true;
    const style = document.createElement('style');
    style.setAttribute('data-vh-terminal-ime', '');
    style.textContent = `
.xterm .xterm-helper-textarea.composing,
.xterm textarea.composing {
    opacity: 1 !important;
    color: #E8EDF4 !important;
    background-color: ${BG} !important;
    caret-color: #34E2C4 !important;
    z-index: 10 !important;
    width: auto !important;
    min-width: 1ch;
    max-width: 90vw;
    white-space: pre !important;
    outline: none !important;
    border: none !important;
    padding: 0 2px !important;
}
.xterm .composition-view {
    background-color: ${BG} !important;
    color: #E8EDF4 !important;
    z-index: 10 !important;
}`;
    document.head.appendChild(style);
}

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
function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}
// Shell-quote a path only if it contains characters that the shell would split.
function shellQuote(p: string): string {
    return /[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

export default function WebTerminalScreen() {
    const { machineId, tid } = useLocalSearchParams<{ machineId: string; tid?: string }>();
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    // Hold the live xterm so the (React-rendered) quick-commands button can
    // paste into it. term.paste goes through bracketed-paste, so a pasted
    // command is NOT auto-run — the user reviews it and presses Enter.
    const termRef = React.useRef<Terminal | null>(null);
    const terminalCommands = useSetting('terminalCommands');
    // Drag-and-drop file upload overlay state ('over' = hovering, 'uploading').
    const [dragState, setDragState] = React.useState<'idle' | 'over' | 'uploading'>('idle');
    const navigation = useNavigation();
    const { theme } = useUnistyles();

    const openCommands = React.useCallback(() => {
        Modal.show({
            component: (props: any) => (
                <SnippetPickerModal
                    {...props}
                    heading={t('terminal.quickCommands')}
                    bodyMono
                    items={terminalCommands.map((c) => ({ id: c.id, title: c.title || c.command.split('\n')[0], body: c.command }))}
                    emptyHint={t('terminal.quickCommandsEmpty')}
                    onPick={(command: string) => { termRef.current?.paste(command); termRef.current?.focus(); }}
                />
            ),
        });
    }, [terminalCommands]);

    // Put the quick-commands launcher + tmux-help into the header's top-right
    // (replaces the old floating button over the terminal, and the layout's
    // help-only headerRight). Keeps the terminal surface clean.
    React.useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    <Pressable
                        onPress={openCommands}
                        hitSlop={8}
                        accessibilityLabel="Quick commands"
                        style={({ pressed }: any) => ({ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
                    >
                        <Ionicons name="flash-outline" size={20} color="#34E2C4" />
                    </Pressable>
                    <Pressable
                        onPress={() => Modal.show({ component: TmuxHelpModal })}
                        hitSlop={8}
                        accessibilityLabel="tmux shortcuts"
                        style={({ pressed }: any) => ({ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
                    >
                        <Ionicons name="help-circle-outline" size={22} color={theme.colors.header.tint} />
                    </Pressable>
                </View>
            ),
        });
    }, [navigation, openCommands, theme.colors.header.tint]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !hostRef.current || !machineId) return;
        const host = hostRef.current;
        injectImeCompositionFix();

        const key = cacheKey(machineId, tid);
        const hit = getTerminalEntry(key);

        // ── Shared state holders ────────────────────────────────────────────
        // terminalId/titled live on the persistent listeners' closures. On a
        // cache hit we DON'T rebuild those listeners, so the build-path closure
        // variables stay valid — we only mirror the entry's stored values back
        // into fresh holders so the host-bound (per-mount) code (resize) can read
        // the current terminalId.
        let entry: TerminalCacheEntry;
        let term: Terminal;
        // getter for the live terminalId (resize uses it; updated in build path)
        let getTerminalId: () => string | null;

        if (hit) {
            // ── REUSE: re-parent the cached xterm root into this host ─────────
            // The socket listeners (output/exit/onData/onKey/OSC52/selection)
            // have stayed alive while hidden and kept writing into this term, so
            // it already holds the latest state. No new Terminal / open /
            // machineOpenTerminal / listener registration — that would double
            // every keystroke. We just move term.element back under `host`.
            entry = hit;
            term = entry.term;
            getTerminalId = () => entry.terminalId;
            if (term.element) host.appendChild(term.element);
            termRef.current = term;
        } else {
            // ── BUILD: first time for this (machineId, tid) ───────────────────
            term = new Terminal({
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
            const unicode11 = new Unicode11Addon();
            term.loadAddon(unicode11);
            term.unicode.activeVersion = '11';
            term.open(host);
            termRef.current = term;

            const persistent: Array<() => void> = [];
            let terminalId: string | null = null;
            getTerminalId = () => terminalId;

            // Clipboard + right-click UX. tmux mouse-mode is ON (for wheel-scroll),
            // so a plain drag is a tmux selection — on release tmux copies it and,
            // because the daemon enabled set-clipboard + the clipboard terminal
            // feature, emits an OSC 52 escape. We mirror that into the browser
            // clipboard, so a plain drag-select copies with NO modifier needed
            // (the highlight clears on release — that's tmux — but the text is
            // copied). A Shift+drag instead makes a native xterm selection that
            // keeps the highlight; we auto-copy that too. These are term-bound
            // (not DOM-bound), so they survive while the tab is hidden.
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
            persistent.push(() => offOsc.dispose());
            const offSel = term.onSelectionChange(() => {
                const sel = term.getSelection();
                if (sel) writeClipboard(sel);
            });
            persistent.push(() => offSel.dispose());

            // Pre-create the entry so we can store the persistent cleanups; the
            // async open below fills in terminalId.
            entry = setTerminalEntry(key, { term, terminalId: null, cleanups: persistent, titled: false });

            term.writeln('\x1b[2m… connecting to ' + machineId + '\x1b[0m');

            (async () => {
                // encStream:true asks the daemon to encrypt the byte stream with the
                // per-machine key. The daemon echoes encStream back iff it supports it
                // (old daemons ignore it → plaintext, still works).
                const res = await machineOpenTerminal(machineId, { terminalId: tid, cols: term.cols, rows: term.rows, encStream: true });
                if (!res.success) {
                    term.writeln('\r\n\x1b[31m✗ ' + res.error + '\x1b[0m');
                    return;
                }
                terminalId = res.terminalId;
                entry.terminalId = res.terminalId;
                const enc = res.encStream === true;

                // The app's machine crypto is async, so serialize input and output
                // through promise chains to preserve byte order. (Daemon crypto is
                // sync, so its side keeps order for free.)
                let outChain: Promise<void> = Promise.resolve();
                const offOut = apiSocket.onMessage('terminal-output', (e: { terminalId: string; data: string; enc?: boolean }) => {
                    if (e.terminalId !== terminalId) return;
                    outChain = outChain.then(async () => {
                        let b64 = e.data;
                        if (e.enc) {
                            const plain = await decryptTerminalData(machineId, e.data);
                            if (plain == null) return; // undecryptable → drop, never render garbage
                            b64 = plain;
                        }
                        term.write(fromBase64(b64));
                    });
                });
                const offExit = apiSocket.onMessage('terminal-exit', (e: { terminalId: string; exitCode: number }) => {
                    if (e.terminalId === terminalId) term.writeln('\r\n\x1b[2m[session ended · exit ' + e.exitCode + ']\x1b[0m');
                });
                persistent.push(offOut, offExit);

                let inChain: Promise<void> = Promise.resolve();
                const offData = term.onData((d) => {
                    const b64 = toBase64(d);
                    inChain = inChain.then(async () => {
                        if (!terminalId) return;
                        if (enc) {
                            const cipher = await encryptTerminalData(machineId, b64);
                            if (cipher != null) {
                                apiSocket.send('terminal-input', { machineId, terminalId, data: cipher, enc: true });
                                return;
                            }
                            // Encryption unavailable (shouldn't happen post-open) — fall
                            // back to plaintext so typing still works.
                        }
                        apiSocket.send('terminal-input', { machineId, terminalId, data: b64 });
                    });
                });
                persistent.push(() => offData.dispose());

                // Auto-title from the first command the user runs (replaces the
                // default machine-name once; a manual rename always wins). Driven
                // by onKey, not onData — onData also carries xterm's replies to
                // terminal queries (device-attributes / color), which would
                // otherwise be captured as a garbage "command". `titled` lives on
                // the entry so a reused terminal never re-titles.
                let lineBuf = '';
                const offKey = term.onKey(({ key: k, domEvent }) => {
                    if (entry.titled || !tid) return;
                    if (domEvent.key === 'Enter') {
                        const cmd = lineBuf.trim();
                        lineBuf = '';
                        if (cmd) { void machineSetTerminalTitle(machineId, tid, cmd, true); entry.titled = true; }
                    } else if (domEvent.key === 'Backspace') {
                        lineBuf = lineBuf.slice(0, -1);
                    } else if (k.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey && !domEvent.altKey) {
                        lineBuf += k;
                    }
                });
                persistent.push(() => offKey.dispose());

                // push the real size now that the session exists
                apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
                term.focus();
            })();
        }

        // ── PER-MOUNT host-bound wiring (recreated on every mount/show) ──────
        // FitAddon + ResizeObserver + DOM event listeners are bound to THIS host
        // element, so they're rebuilt each mount and torn down on unmount (the
        // term itself survives). FitAddon is cheap to re-add; xterm dedupes.
        const fit = new FitAddon();
        term.loadAddon(fit);
        // (disposed in mountCleanups below so reused terminals don't accumulate
        // stale FitAddon instances across tab switches.)
        // FitAddon picks cols = floor(width / cellWidth) using a *fractional*
        // cell width, but the DOM renderer lays out cells at rounded widths, so
        // the rendered grid can end up a hair WIDER than the host. With the host
        // on overflow:hidden that shaves the last column's glyph — visibly, tmux's
        // trailing status-bar date loses its right edge ("6" cut in half). Fit,
        // then if the rendered screen reaches/overflows the host edge, drop one
        // column so the last cell always has room. Width-independent (works at any
        // window size) — unlike a fixed right padding, which just moves the clip.
        const safeFit = () => {
            try { fit.fit(); } catch { return; }
            const screenEl = host.querySelector('.xterm-screen') as HTMLElement | null;
            if (screenEl && term.cols > 2) {
                const slack = host.clientWidth - screenEl.getBoundingClientRect().width;
                if (slack < 3) {
                    term.resize(term.cols - 1, term.rows);
                }
            }
        };
        safeFit();

        const mountCleanups: Array<() => void> = [];
        mountCleanups.push(() => { try { fit.dispose(); } catch { /* noop */ } });

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
        mountCleanups.push(() => host.removeEventListener('contextmenu', onCtx));

        // Drag-and-drop file upload: drop a file onto the terminal → it's staged
        // on the machine (~/.happy/uploads/terminal/) and its absolute path is
        // pasted at the cursor (bracketed-paste, not auto-run) so you can use it
        // in a command. Multiple files → space-separated, shell-quoted paths.
        const onDragOver = (e: DragEvent) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDragState((s) => (s === 'uploading' ? s : 'over'));
        };
        const onDragLeave = (e: DragEvent) => {
            if (!host.contains(e.relatedTarget as Node | null)) setDragState((s) => (s === 'uploading' ? s : 'idle'));
        };
        const onDrop = (e: DragEvent) => {
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length) { setDragState('idle'); return; }
            e.preventDefault();
            setDragState('uploading');
            void (async () => {
                const paths: string[] = [];
                for (const f of files) {
                    try {
                        const buf = new Uint8Array(await f.arrayBuffer());
                        const res = await machineUploadFile(machineId, f.name, bytesToBase64(buf));
                        if (res.success && res.path) paths.push(res.path);
                        else term.writeln('\r\n\x1b[31m✗ upload failed: ' + (res.error || f.name) + '\x1b[0m');
                    } catch {
                        term.writeln('\r\n\x1b[31m✗ upload error: ' + f.name + '\x1b[0m');
                    }
                }
                setDragState('idle');
                if (paths.length) {
                    term.paste(paths.map(shellQuote).join(' ') + ' ');
                    term.focus();
                }
            })();
        };
        // Capture phase (3rd arg true): xterm mounts a textarea + canvas/rows
        // inside `host`; a real OS file-drag lands on one of those inner nodes,
        // and if xterm stops propagation we'd never see a bubbling drop. Capturing
        // on `host` runs before any inner handler, so the drop always registers
        // (and our dragover preventDefault enables the drop for the whole subtree).
        host.addEventListener('dragover', onDragOver, true);
        host.addEventListener('dragleave', onDragLeave, true);
        host.addEventListener('drop', onDrop, true);
        mountCleanups.push(() => {
            host.removeEventListener('dragover', onDragOver, true);
            host.removeEventListener('dragleave', onDragLeave, true);
            host.removeEventListener('drop', onDrop, true);
        });

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
            mountCleanups.push(() => ta.removeEventListener('focus', onFocus));
        }

        const ro = new ResizeObserver(() => {
            safeFit();
            const id = getTerminalId();
            if (id) apiSocket.send('terminal-resize', { machineId, terminalId: id, cols: term.cols, rows: term.rows });
        });
        ro.observe(host);
        mountCleanups.push(() => ro.disconnect());

        // On reuse, force a repaint of the current screen + push the (possibly
        // changed) size, then focus — so switching back shows up-to-date content
        // and an active cursor immediately.
        if (hit) {
            const id = getTerminalId();
            if (id) apiSocket.send('terminal-resize', { machineId, terminalId: id, cols: term.cols, rows: term.rows });
            term.refresh(0, term.rows - 1);
            term.focus();
        }

        return () => {
            // KEEP-ALIVE cleanup: tear down only the host-bound wiring and detach
            // the xterm root from the DOM. Do NOT terminal-close, NOT dispose the
            // term, NOT dispose the socket/term listeners — they stay alive so the
            // tmux session keeps streaming into the cached term while hidden, and
            // switching back is instant. True teardown happens via the LRU cap in
            // the cache module (or disposeTerminalCache on a future kill path).
            mountCleanups.forEach((c) => c());
            if (term.element && term.element.parentNode === host) host.removeChild(term.element);
            if (termRef.current === term) termRef.current = null;
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
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', backgroundColor: BG, paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8 }}>
            {/* @ts-ignore web-only DOM host */}
            <div ref={hostRef} style={{ flex: 1, width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', boxSizing: 'border-box' }} />
            {/* (Quick-commands launcher moved into the header top-right.) */}

            {/* Drag-and-drop upload overlay. pointerEvents:none so drop events
                still reach the terminal host underneath. */}
            {dragState !== 'idle' && (
                <View
                    // @ts-ignore web-only prop
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        top: 8, left: 8, right: 8, bottom: 8,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(5,7,10,0.78)',
                        borderWidth: 2,
                        borderColor: '#34E2C4',
                        borderStyle: 'dashed',
                        borderRadius: 10,
                    }}
                >
                    <Ionicons
                        name={dragState === 'uploading' ? 'cloud-upload-outline' : 'download-outline'}
                        size={36}
                        color="#34E2C4"
                    />
                    <Text style={{ color: '#E8EDF4', marginTop: 12, fontSize: 14 }}>
                        {dragState === 'uploading' ? t('terminal.uploadingFile') : t('terminal.dropToUpload')}
                    </Text>
                    <Text style={{ color: '#5B6675', marginTop: 4, fontSize: 12 }}>
                        {t('terminal.pathWillBePasted')}
                    </Text>
                </View>
            )}
        </View>
    );
}
