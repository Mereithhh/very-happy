import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronLeft, Pencil, ListPlus, HelpCircle } from 'lucide-react';
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
  const termRef = useRef<Terminal | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const navigateTo = navigate;

  useEffect(() => {
    if (!machineId || !hostRef.current || !innerRef.current) return;
    ensureImeFix();
    const mount = innerRef.current;

    const term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: IS_COARSE_POINTER ? 12 : 13, lineHeight: 1.3, cursorBlink: true, theme: THEME, allowProposedApi: true, convertEol: false,
      scrollback: 5000,
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
    // OSC 52 → system clipboard. tmux copy-mode yank (set-clipboard on) and
    // apps like Claude Code emit OSC 52; without this addon xterm silently drops
    // it and nothing reaches the browser clipboard. Write-only by default (the
    // addon does not allow clipboard READ, avoiding exfiltration).
    term.loadAddon(new ClipboardAddon());
    // Unicode 11 widths: fixes CJK / emoji / box-drawing column alignment in the
    // Claude Code TUI (needs allowProposedApi, already set, + activeVersion).
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(mount);
    termRef.current = term;

    const safeFit = () => {
      try { fit.fit(); } catch { /* not laid out yet */ }
    };
    requestAnimationFrame(safeFit);
    const t0 = setTimeout(safeFit, 60);

    let terminalId = '';
    let enc = false;
    let disposed = false;
    let titleBuf = '';
    let titled = false;
    let outChain: Promise<void> = Promise.resolve();

    const onOutput = (e: { terminalId: string; data: string; enc?: boolean }) => {
      if (disposed || e.terminalId !== terminalId) return;
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
      setConnecting(false);
      requestAnimationFrame(doFit);
      term.focus();
    })();

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
      if (p) { touchX = p.clientX; touchY = p.clientY; }
    };
    const onTouchEnd = (e: TouchEvent) => {
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
        host.style.maxHeight = '';
      }
      if (!IS_COARSE_POINTER) {
        host.removeEventListener('mousedown', onMouseDown, true);
        host.removeEventListener('mouseup', onMouseUp, true);
      }
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
      <div ref={hostRef} className="term-host">
        <div ref={innerRef} className="term-host-inner" />
      </div>
      {showHelp && <TmuxHelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
