import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { createTerminalRenderer, type TerminalRenderer } from './renderer';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronLeft, Pencil, ListPlus, HelpCircle, TextSelect } from 'lucide-react';
import { apiSocket } from '@/sync/apiSocket';
import {
  machineOpenTerminal,
  encryptTerminalData,
  decryptTerminalData,
  machineUploadFile,
  machineSetTerminalTitle,
} from '@/sync/ops';
import { useSettings } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useIsDesktop } from '@/app/useMediaQuery';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { ensureImeFix } from './imeFix';
import { TmuxHelpModal } from './TmuxHelpModal';
import './terminal.css';

function strToB64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const THEME = {
  background: '#0B0E13', foreground: '#E8EDF4', cursor: '#34E2C4', cursorAccent: '#04110E',
  selectionBackground: 'rgba(52,226,196,0.25)', black: '#0B0E13', brightBlack: '#5B6675',
  red: '#FF6B6B', green: '#34E2C4', yellow: '#E6B450', blue: '#7AA2D6', magenta: '#C792EA',
  cyan: '#34E2C4', white: '#E8EDF4',
};

// Explicit mono stack — NOT the --font-mono CSS var: xterm measures glyph size
// from this string directly (canvas), where a var() fails to resolve → it falls
// back to a different font whose metrics don't match what's rendered → clipped
// glyphs. lineHeight 1.3 gives descenders and CJK vertical room (default 1.0 is
// cramped). IBM Plex Mono loads async via @fontsource, so we also re-measure
// once document.fonts is ready (below) — otherwise the cell size is locked to
// the fallback metrics and text gets clipped after the real font swaps in.
const TERM_FONT = "'IBM Plex Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";

// Touch-first device (phone/tablet). Evaluated once at module load — pointer
// capability doesn't change at runtime, and all mobile-only behavior below is
// gated on this so desktop is untouched.
const IS_COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export function WebTerminalScreen() {
  const { machineId } = useParams<{ machineId: string }>();
  const [params] = useSearchParams();
  const tid = params.get('tid') ?? undefined;
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { t } = useTranslation();
  const settings = useSettings();
  const terminals = useTerminalSessions((s) => s.terminals);
  const renameTerminal = useTerminalSessions((s) => s.rename);
  const autoTitle = useTerminalSessions((s) => s.autoTitle);
  const meta = terminals.find((x) => x.id === tid);
  const title = meta?.title || meta?.machineName || t('newSessionModal.terminalTitle' as any);

  const hostRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalRenderer | null>(null);
  // Bridge the effect-local sendInput (base64 → socket, honours encryption) out
  // to the assistive key bar handlers below, which live outside the effect.
  const sendInputRef = useRef<((d: string) => void) | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  // Mobile select-mode: touch has one gesture, and by default we spend it on
  // scrolling (drag → synthetic wheel). Toggling this hands the gesture back to
  // the browser so the OS long-press text selection works on the DOM-rendered
  // terminal text (→ system copy). The touch handlers read the ref (they're set
  // up once), the state drives the button + host className.
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(false);
  // Mobile assistive key bar: soft keyboards have no Esc/Tab/Ctrl/arrows/pipe,
  // which makes claude/shell/vim painful. `ctrlSticky` is a one-shot modifier —
  // tap Ctrl, then the next letter is sent as Ctrl+<letter> (\x01..\x1a).
  const [ctrlSticky, setCtrlSticky] = useState(false);
  const navigateTo = navigate;

  useEffect(() => {
    if (!machineId || !hostRef.current || !innerRef.current) return;
    ensureImeFix();
    const mount = innerRef.current;

    // Renderer abstraction (see ./renderer): the daemon-authoritative core below
    // (subscribe / snapshot / seq / encryption / input) is renderer-agnostic, so
    // it's built through a factory that today returns the xterm.js DOM renderer
    // and could return a ghostty/Restty (canvas / WebGPU) renderer behind a flag.
    // termRef holds the abstraction; its external consumers (runCommand /
    // toggleSelectMode) use only interface methods. The delicate DOM-coupled logic
    // in THIS effect (IME/focus textarea, synthetic-wheel scroll, private font
    // re-measure) still reaches the xterm instance directly via `raw` — those are
    // xterm-specific and get migrated behind explicit interface methods (or
    // re-solved for canvas) when a non-xterm renderer actually ships.
    const renderer = createTerminalRenderer('xterm', {
      mount,
      fontFamily: TERM_FONT,
      fontSize: IS_COARSE_POINTER ? 12 : 13,
      theme: THEME,
      scrollback: 5000,
      coarsePointer: IS_COARSE_POINTER,
    });
    const term = renderer.raw!;
    termRef.current = renderer;

    const safeFit = () => renderer.fit();
    requestAnimationFrame(safeFit);
    const t0 = setTimeout(safeFit, 60);

    let terminalId = '';
    let enc = false;
    let disposed = false;
    let titleBuf = '';
    let titled = false;
    let outChain: Promise<void> = Promise.resolve();
    // Daemon-authoritative screen model: the daemon assigns a monotonic `seq`
    // to every output chunk. We track the highest seq we've applied so that on a
    // socket reconnect we can ask for `fromSeq=lastSeq` and the daemon replays
    // only the gap (or sends a fresh snapshot if the gap scrolled out of its
    // ring). Chunks are deduped by seq so a replayed-then-live overlap never
    // double-writes. Starts at 0; first live chunk is seq 1.
    let lastSeq = 0;

    const onOutput = (e: { terminalId: string; data: string; seq?: number; enc?: boolean }) => {
      if (disposed || e.terminalId !== terminalId) return;
      // Drop anything we've already applied (e.g. a live chunk that overlaps a
      // reconnect replay). seq is monotonic per terminal on the daemon.
      if (typeof e.seq === 'number') {
        if (e.seq <= lastSeq) return;
        lastSeq = e.seq;
      }
      if (e.enc) {
        outChain = outChain.then(async () => {
          const plain = await decryptTerminalData(machineId, e.data);
          if (plain && !disposed) term.write(b64ToBytes(plain));
        });
      } else {
        term.write(b64ToBytes(e.data));
      }
    };
    const onExit = (e: { terminalId: string; exitCode?: number }) => {
      if (disposed || e.terminalId !== terminalId) return;
      term.writeln(`\r\n\x1b[38;2;91;102;117m[process exited${e.exitCode != null ? ` (${e.exitCode})` : ''}]\x1b[0m`);
    };
    apiSocket.onMessage('terminal-output', onOutput);
    apiSocket.onMessage('terminal-exit', onExit);

    const sendInput = (d: string) => {
      const b64 = strToB64(d);
      if (enc) {
        encryptTerminalData(machineId, b64).then((c) => {
          if (c && !disposed) apiSocket.send('terminal-input', { machineId, terminalId, data: c, enc: true });
        });
      } else {
        apiSocket.send('terminal-input', { machineId, terminalId, data: b64 });
      }
    };
    const dataDisp = term.onData(sendInput);
    sendInputRef.current = sendInput;

    // ── Mobile English-input fix (coarse pointer only) ──────────────────────
    // Root cause (verified against xterm 5.5 lib/xterm.js CompositionHelper +
    // CoreBrowserTerminal._inputEvent):
    //  • Soft keyboards (iOS, Gboard) don't emit clean keypress for letters.
    //    A letter arrives as keydown(keyCode 229 = "composing") → the char lands
    //    only via the textarea `input` event, often wrapped in a composition.
    //  • xterm._keyDown sets `_keyDownSeen=true` (reset only on keyup). Its
    //    `_inputEvent` then flushes to onData ONLY when
    //    `e.data && inputType==='insertText' && (!e.composed || !_keyDownSeen)`.
    //    On mobile the composed `input` has `e.composed===true` AND
    //    `_keyDownSeen===true`, so that branch is skipped → the char is NEVER
    //    passed to onData from _inputEvent.
    //  • The only remaining flush is compositionend → _finalizeComposition. But
    //    Gboard/iOS predictive text keeps the composition OPEN across a whole
    //    word (only ending on space/enter/punct), so letters pile up in the
    //    (now visible, teal) .composition-view bubble and never reach the pty:
    //    "typing shows nothing / can't get into the terminal".
    // Fix: on mobile only, own the helper textarea's `input` in the CAPTURE
    // phase (xterm listens in bubble; it does NOT listen to beforeinput). While
    // a real IME composition is active (CJK pinyin) we do NOTHING and let
    // xterm's compositionend path run (that already works — imeFix styles it).
    // Outside composition, we send inserted text ourselves, delete-backward as
    // DEL, and keep the textarea empty so xterm's _keyDownSeen/_isComposing
    // bookkeeping can never strand a character. Desktop is untouched.
    let imeComposing = false;
    let mobileBridgeTa: HTMLTextAreaElement | null = null;
    const onCompStart = () => { imeComposing = true; };
    const onCompEnd = () => { imeComposing = false; };
    const onTaInput = (ev: Event) => {
      if (imeComposing) return; // CJK IME in flight → xterm's compositionend handles it
      const e = ev as InputEvent;
      const ta = mobileBridgeTa;
      if (!ta) return;
      const type = e.inputType;
      // NB: we deliberately do NOT handle 'insertCompositionText' — that's the
      // commit type CJK/predictive IMEs use, and xterm's compositionend path
      // already handles it correctly (imeFix styles its bubble). We only rescue
      // the discrete 'insertText' the mobile path strands (see header comment).
      if (type === 'insertText' || type === 'insertFromPaste') {
        if (typeof e.data === 'string' && e.data.length) sendInput(e.data);
      } else if (type === 'deleteContentBackward') {
        sendInput('\x7f'); // DEL — matches xterm's own backspace-in-textarea handling
      } else if (type === 'insertLineBreak' || type === 'insertParagraph') {
        sendInput('\r');
      } else {
        return; // unknown editing op → let it be (don't clear)
      }
      // Consume so xterm's bubble-phase `input` can't double-send or strand it,
      // and reset the textarea + xterm composing flags to a clean slate.
      e.stopImmediatePropagation();
      ta.value = '';
      try {
        const core = (term as any)._core;
        if (core) { core._keyDownSeen = false; core._keyPressHandled = false; }
      } catch { /* private API best-effort */ }
    };

    const keyDisp = term.onKey(({ key, domEvent }) => {
      if (titled) return;
      if (domEvent.key === 'Enter') {
        const tt = titleBuf.trim();
        if (tt && tid) {
          autoTitle(tid, tt.slice(0, 60));
          machineSetTerminalTitle(machineId, terminalId, tt.slice(0, 60), true).catch(() => {});
        }
        titled = true;
      } else if (domEvent.key === 'Backspace') titleBuf = titleBuf.slice(0, -1);
      else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey && !domEvent.altKey) titleBuf += key;
    });

    const doFit = () => {
      safeFit();
      if (terminalId) apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
    };
    // Debounce refits to the next frame so a burst of resize ticks collapses into
    // one fit AFTER layout settles — otherwise the xterm canvas keeps its old
    // (too-tall) size mid-resize and the host shows a scrollbar instead of reflowing.
    let fitRaf = 0;
    const scheduleFit = () => {
      if (fitRaf) cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        doFit();
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(mount);
    window.addEventListener('resize', scheduleFit);
    // Regain input focus + clear any stuck IME composition. Two failure modes
    // this fixes on desktop: (1) after switching browser tab / app window away
    // and back, the hidden textarea has lost focus and typing goes nowhere until
    // you click; (2) switching input method (IME) mid-session can leave xterm's
    // internal _isComposing=true — every keydown is then silently swallowed and
    // the terminal appears frozen. Blurring the helper textarea fires
    // compositionend per spec, which resets that flag; then we refocus. Guarded
    // to fine pointers so mobile never force-opens the soft keyboard.
    const refocus = () => {
      if (IS_COARSE_POINTER || disposed || document.hidden) return;
      const ta = term.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (ta) ta.blur();
      term.focus();
    };
    // rAF is paused while the tab is hidden, so a resize that lands in the
    // background never gets fitted; re-fit when the tab becomes visible again.
    const onVisible = () => { if (!document.hidden) { scheduleFit(); refocus(); } };
    document.addEventListener('visibilitychange', onVisible);
    // Returning to the window (alt-tab / app switch) restores focus to the body,
    // not the terminal — refocus so the user can type immediately.
    window.addEventListener('focus', refocus);
    // The web font loads async; xterm caches glyph cell size at open time from
    // whatever font was available then. Once the real font is ready, force a
    // re-measure so the cell size matches and text isn't clipped, then refit.
    (document as any).fonts?.ready?.then(() => {
      if (disposed) return;
      try { (term as any)._core?._charSizeService?.measure?.(); } catch { /* private API best-effort */ }
      scheduleFit();
    });

    // Apply an open-terminal result to the xterm screen. The daemon owns the
    // screen, so a `snapshot` fully restores it (reset + write) and a `replay`
    // just fills the gap after a reconnect (write each chunk in seq order, no
    // reset). onOutput's seq dedup guards against overlap with live chunks that
    // land during this async decrypt. Sets `lastSeq` to the daemon's baseline.
    const applyOpenResult = async (res: Extract<Awaited<ReturnType<typeof machineOpenTerminal>>, { success: true }>) => {
      const writeMaybeEnc = async (dataB64: string) => {
        if (res.encStream) {
          const plain = await decryptTerminalData(machineId, dataB64);
          if (plain && !disposed) term.write(b64ToBytes(plain));
        } else {
          term.write(b64ToBytes(dataB64));
        }
      };
      if (res.mode === 'snapshot') {
        term.reset();
        await writeMaybeEnc(res.data);
      } else {
        // Replay: apply only chunks newer than what we already have.
        for (const c of res.chunks) {
          if (c.seq <= lastSeq) continue;
          await writeMaybeEnc(c.data);
          lastSeq = c.seq;
        }
      }
      // The daemon's current seq is our new baseline (covers the snapshot case
      // and any chunks the replay didn't include).
      lastSeq = Math.max(lastSeq, res.seq);
    };

    // Open (first subscribe): no fromSeq → the daemon returns a fresh snapshot.
    (async () => {
      safeFit();
      const res = await machineOpenTerminal(machineId, { terminalId: tid, cols: term.cols, rows: term.rows, encStream: true });
      if (disposed) return;
      if (!res.success) {
        term.writeln(`\x1b[38;2;255;107;107m✗ ${res.error}\x1b[0m`);
        setConnecting(false);
        return;
      }
      terminalId = res.terminalId;
      enc = res.encStream === true;
      // Serialize the restore behind outChain so any live chunk arriving mid-
      // restore is applied after it (and seq-deduped), never interleaved.
      outChain = outChain.then(() => applyOpenResult(res));
      setConnecting(false);
      requestAnimationFrame(doFit);
      term.focus();
    })();

    // On socket reconnect (dropped then back), re-subscribe with fromSeq=lastSeq.
    // The daemon replays just the missed output, or resends a snapshot if the
    // gap scrolled out of its ring. Only fires once the initial open established
    // a terminalId (onReconnected also fires on the very first connect).
    const offReconnected = apiSocket.onReconnected(() => {
      if (disposed || !terminalId) return;
      outChain = outChain.then(async () => {
        const res = await machineOpenTerminal(machineId, {
          terminalId, cols: term.cols, rows: term.rows, fromSeq: lastSeq, encStream: true,
        });
        if (disposed || !res.success) return;
        enc = res.encStream === true;
        await applyOpenResult(res);
        if (terminalId) apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
      });
    });

    const host = hostRef.current;
    const onDragOver = (e: DragEvent) => { e.preventDefault(); host.classList.add('is-dragover'); };
    const onDragLeave = () => host.classList.remove('is-dragover');
    const onDrop = async (e: DragEvent) => {
      e.preventDefault(); host.classList.remove('is-dragover');
      for (const f of Array.from(e.dataTransfer?.files ?? [])) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const r = await machineUploadFile(machineId, f.name, btoa(bin));
        if (r.success && r.path) term.paste(`'${r.path}' `);
      }
    };
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);

    // ── Mobile (coarse pointer) only: tap-to-focus + soft-keyboard avoidance ──
    // On iOS Safari, xterm's hidden textarea never receives focus from a plain
    // tap on the canvas, so the soft keyboard never opens and the terminal is
    // uneditable. We detect a tap ourselves (small touch displacement) and call
    // term.focus() SYNCHRONOUSLY in the touchend handler — iOS only opens the
    // keyboard when focus happens inside the user-gesture call stack (no rAF /
    // setTimeout). Capture phase so xterm's internal stopPropagation can't eat
    // it; passive so scrolling stays smooth. Large displacement = scroll or
    // text selection → don't steal focus.
    let touchX = 0;
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      const p = e.touches[0];
      if (selectModeRef.current) return; // let the browser select/scroll natively
      if (p) { touchX = p.clientX; touchY = p.clientY; }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (selectModeRef.current) return;
      const p = e.changedTouches[0];
      if (!p) return;
      const dx = p.clientX - touchX;
      const dy = p.clientY - touchY;
      if (dx * dx + dy * dy <= 12 * 12) term.focus();
    };
    // Touch drag → synthetic wheel events, so mobile can scroll back through
    // history. xterm has no useful touch handling: on desktop the wheel is
    // what gets translated into tmux mouse sequences (tmux mouse-mode →
    // copy-mode scrollback), and on mobile that input simply doesn't exist.
    // We reuse the tap threshold (12px) as the gesture gate: a drag beyond it
    // becomes a scroll (and the tap handler above already ignores it). Each
    // accumulated line-height of vertical movement dispatches one WheelEvent
    // at the xterm screen element, exactly like a desktop wheel tick.
    // Direction follows natural touch scrolling: finger down = see earlier
    // content = wheel up (negative deltaY). Multi-touch (pinch) is left alone.
    // preventDefault (non-passive listener below) stops the page/viewport from
    // scrolling along — but only once the gesture is classified as a scroll,
    // so taps are unaffected.
    let scrollActive = false;
    let scrollLastY = 0;
    let scrollAccum = 0;
    const onTouchMove = (e: TouchEvent) => {
      if (selectModeRef.current) return; // native selection/scroll, don't hijack
      if (e.touches.length > 1) { scrollActive = false; return; }
      const p = e.touches[0];
      if (!p) return;
      if (!scrollActive) {
        const dx = p.clientX - touchX;
        const dy = p.clientY - touchY;
        if (dx * dx + dy * dy <= 12 * 12) return; // still a potential tap
        scrollActive = true;
        scrollLastY = p.clientY;
        scrollAccum = 0;
      }
      if (e.cancelable) e.preventDefault();
      scrollAccum += p.clientY - scrollLastY;
      scrollLastY = p.clientY;
      const termEl = term.element;
      const lineH = Math.max(12, (termEl?.clientHeight ?? mount.clientHeight) / Math.max(1, term.rows));
      const lines = Math.trunc(scrollAccum / lineH);
      if (lines === 0) return;
      scrollAccum -= lines * lineH;
      const target = host.querySelector('.xterm-screen') ?? termEl;
      if (!target) return;
      // finger moved down (lines > 0) → wheel up → negative deltaY.
      // clientX/Y matter: tmux mouse reports carry cell coordinates.
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -lines * lineH,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        clientX: p.clientX,
        clientY: p.clientY,
        bubbles: true,
        cancelable: true,
      }));
    };
    const onTouchDone = () => { scrollActive = false; scrollAccum = 0; };
    // When the soft keyboard opens, window.innerHeight doesn't change — only
    // window.visualViewport shrinks — so the keyboard covers the bottom of the
    // terminal (including the input line). Cap the host's height to the visible
    // viewport portion; the ResizeObserver → scheduleFit chain then shrinks the
    // xterm grid (and tmux rows follow via terminal-resize).
    const vv = window.visualViewport;
    const onViewport = () => {
      if (!vv) return;
      if (vv.height >= window.innerHeight - 50) {
        // Keyboard dismissed (viewport ≈ full window) → restore natural layout.
        if (host.style.maxHeight) {
          host.style.maxHeight = '';
          scheduleFit();
        }
        return;
      }
      const hostTop = host.getBoundingClientRect().top;
      const avail = Math.round(vv.offsetTop + vv.height - hostTop - 8);
      if (avail > 60) {
        host.style.maxHeight = `${avail}px`;
        scheduleFit();
      }
    };
    if (IS_COARSE_POINTER) {
      host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      // NOT passive: we preventDefault once a drag is classified as a scroll.
      host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      host.addEventListener('touchend', onTouchDone, { capture: true, passive: true });
      host.addEventListener('touchcancel', onTouchDone, { capture: true, passive: true });
      vv?.addEventListener('resize', onViewport);
      vv?.addEventListener('scroll', onViewport);
      // Wire the mobile English-input bridge to xterm's helper textarea (exists
      // after term.open above). Capture phase beats xterm's bubble `input`.
      mobileBridgeTa = term.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (mobileBridgeTa) {
        // Hint the OS toward a plain text keyboard (no numeric/url/email mode);
        // enterKeyHint 'send' gives a sensible Return label for a shell prompt.
        mobileBridgeTa.setAttribute('inputmode', 'text');
        mobileBridgeTa.setAttribute('enterkeyhint', 'send');
        mobileBridgeTa.addEventListener('compositionstart', onCompStart, true);
        mobileBridgeTa.addEventListener('compositionend', onCompEnd, true);
        mobileBridgeTa.addEventListener('input', onTaInput, true);
      }
    }

    // Desktop: click-to-focus fallback. xterm only focuses its hidden textarea
    // from its own internal mousedown path — clicks landing on the host's
    // padding (or after an odd focus loss) miss it and typing goes nowhere
    // until you hit the canvas exactly. A plain click (tiny displacement, and
    // no selection made — don't break drag-to-copy) refocuses the terminal.
    // Capture phase so inner stopPropagation can't eat it.
    let mouseX = 0;
    let mouseY = 0;
    const onMouseDown = (e: MouseEvent) => { mouseX = e.clientX; mouseY = e.clientY; };
    const onMouseUp = (e: MouseEvent) => {
      const dx = e.clientX - mouseX;
      const dy = e.clientY - mouseY;
      if (dx * dx + dy * dy > 5 * 5) {
        // Drag = a selection was made. Copy-on-select: mirror it to the system
        // clipboard (mouseup is a user gesture, so writeText is allowed). Keep
        // the selection visible; don't steal focus. ⌘C / right-click still work.
        if (term.hasSelection()) {
          const sel = term.getSelection();
          if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        }
        return;
      }
      if (term.hasSelection()) return;
      refocus(); // also clears a stuck IME composition, not just plain focus
    };
    if (!IS_COARSE_POINTER) {
      host.addEventListener('mousedown', onMouseDown, true);
      host.addEventListener('mouseup', onMouseUp, true);
    }

    return () => {
      disposed = true;
      clearTimeout(t0);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('focus', refocus);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      offReconnected();
      apiSocket.offMessage('terminal-output', onOutput);
      apiSocket.offMessage('terminal-exit', onExit);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
      if (IS_COARSE_POINTER) {
        host.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchend', onTouchEnd, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchend', onTouchDone, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchcancel', onTouchDone, { capture: true } as EventListenerOptions);
        vv?.removeEventListener('resize', onViewport);
        vv?.removeEventListener('scroll', onViewport);
        if (mobileBridgeTa) {
          mobileBridgeTa.removeEventListener('compositionstart', onCompStart, true);
          mobileBridgeTa.removeEventListener('compositionend', onCompEnd, true);
          mobileBridgeTa.removeEventListener('input', onTaInput, true);
          mobileBridgeTa = null;
        }
        host.style.maxHeight = '';
      }
      if (!IS_COARSE_POINTER) {
        host.removeEventListener('mousedown', onMouseDown, true);
        host.removeEventListener('mouseup', onMouseUp, true);
      }
      sendInputRef.current = null;
      dataDisp.dispose();
      keyDisp.dispose();
      if (terminalId) apiSocket.send('terminal-close', { machineId, terminalId });
      term.dispose();
      termRef.current = null;
    };
  }, [machineId, tid, autoTitle]);

  const runCommand = (command: string) => {
    const tm = termRef.current;
    if (!tm) return;
    tm.paste(command); // user presses Enter to run — never auto-execute
    tm.focus();
  };

  const onRename = async () => {
    if (!tid) return;
    const next = await Modal.prompt(t('common.rename' as any), undefined, { defaultValue: title });
    if (next != null) renameTerminal(tid, next);
  };

  const toggleSelectMode = () => {
    const next = !selectModeRef.current;
    selectModeRef.current = next;
    setSelectMode(next);
    const tm = termRef.current;
    if (next) {
      // Drop terminal focus so the soft keyboard closes and the OS long-press
      // selection isn't fighting the caret / input.
      tm?.blur?.();
      (tm?.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null)?.blur();
    } else {
      tm?.focus();
    }
  };

  // Send raw bytes to the pty via the effect's sendInput (base64/encryption
  // aware), then return focus to the terminal so the soft keyboard stays up.
  const sendBytes = (bytes: string) => {
    sendInputRef.current?.(bytes);
    termRef.current?.focus();
  };
  // A literal key from the bar. If Ctrl is armed and this is a single ASCII
  // letter, fold it to its control code (Ctrl+A=\x01 … Ctrl+Z=\x1a) and consume
  // the sticky. Otherwise send the sequence verbatim.
  const sendBarKey = (seq: string) => {
    if (ctrlSticky && seq.length === 1) {
      const c = seq.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) {
        sendBytes(String.fromCharCode(c - 96)); // 'a'(97) → \x01
        setCtrlSticky(false);
        return;
      }
    }
    sendBytes(seq);
    if (ctrlSticky) setCtrlSticky(false);
  };
  // The static (non-letter) bar keys. Ctrl is handled separately (sticky).
  const BAR_KEYS: Array<{ label: string; seq: string; aria: string; wide?: boolean }> = [
    { label: 'Esc', seq: '\x1b', aria: 'Escape', wide: true },
    { label: 'Tab', seq: '\t', aria: 'Tab', wide: true },
    { label: '↑', seq: '\x1b[A', aria: 'Arrow up' },
    { label: '↓', seq: '\x1b[B', aria: 'Arrow down' },
    { label: '←', seq: '\x1b[D', aria: 'Arrow left' },
    { label: '→', seq: '\x1b[C', aria: 'Arrow right' },
    { label: '|', seq: '|', aria: 'Pipe' },
    { label: '~', seq: '~', aria: 'Tilde' },
    { label: '/', seq: '/', aria: 'Slash' },
    { label: '-', seq: '-', aria: 'Dash' },
  ];

  const cmds = (settings.terminalCommands ?? []) as Array<{ id: string; title: string; command: string }>;

  return (
    <div className="term-screen">
      <header className="term-header">
        {!isDesktop && (
          <button className="term-back" onClick={() => navigate('/')} aria-label="back">
            <ChevronLeft size={18} />
          </button>
        )}
        <button className="term-title" onClick={onRename} title={t('common.rename' as any)}>
          <span className="term-title-text">{title}</span>
          <Pencil size={13} className="term-title-edit" />
        </button>
        <div className="term-header-right">
          {connecting && <span className="term-connecting mono">{t('common.loading' as any)}</span>}
          {!isDesktop && (
            <button
              className={`sb-icon-btn${selectMode ? ' is-active' : ''}`}
              title={t('terminal.selectMode' as any)}
              aria-pressed={selectMode}
              onClick={toggleSelectMode}
            >
              <TextSelect size={18} />
            </button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="sb-icon-btn" title={t('settingsSnippets.commandsGroup' as any)}>
                <ListPlus size={18} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="vh-menu" align="end" sideOffset={6}>
                {cmds.length > 0 ? (
                  cmds.map((c) => (
                    <DropdownMenu.Item key={c.id} className="vh-menu-item" onSelect={() => runCommand(c.command)}>
                      {c.title}
                    </DropdownMenu.Item>
                  ))
                ) : (
                  <DropdownMenu.Item
                    className="vh-menu-item"
                    onSelect={() => navigateTo('/settings/snippets')}
                  >
                    {t('settingsSnippets.addCommand' as any)}
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            className="sb-icon-btn"
            title={t('tmuxHelp.title' as any)}
            onClick={() => setShowHelp(true)}
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </header>
      <div ref={hostRef} className={`term-host${selectMode ? ' is-selecting' : ''}`}>
        {selectMode && <div className="term-select-hint mono">{t('terminal.selectModeHint' as any)}</div>}
        <div ref={innerRef} className="term-host-inner" />
      </div>
      {IS_COARSE_POINTER && !selectMode && (
        <div className="term-keybar" role="toolbar" aria-label={t('terminal.keybarLabel')}>
          <button
            type="button"
            className={`term-keybar-key term-keybar-mod${ctrlSticky ? ' is-armed' : ''}`}
            aria-pressed={ctrlSticky}
            aria-label="Control"
            // Don't blur the terminal (which would drop the soft keyboard).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setCtrlSticky((v) => !v); termRef.current?.focus(); }}
          >
            Ctrl
          </button>
          {BAR_KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              className={`term-keybar-key${k.wide ? ' term-keybar-wide' : ''}`}
              aria-label={k.aria}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendBarKey(k.seq)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      {showHelp && <TmuxHelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
