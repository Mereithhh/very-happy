import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { createTerminalRenderer, type TerminalRenderer } from './renderer';
import { ChevronLeft, Pencil, HelpCircle, TextSelect, KeyboardOff, TextCursorInput, FolderOpen, X } from 'lucide-react';
import { apiSocket } from '@/sync/apiSocket';
import {
  machineOpenTerminal,
  encryptTerminalData,
  decryptTerminalData,
  machineUploadFile,
  machineSetTerminalTitle,
  machineScrollTerminal,
} from '@/sync/ops';
import { installMobileInputBridge, toPtyText } from './mobileInputBridge';
import { installImeStuckGuard } from './imeStuckGuard';
import { TermInputBar } from './TermInputBar';
import { TermPresetsMenu } from './TermPresetsMenu';
import { presetPasteText } from './termPresetPaste';
import { useSettings, useLocalSettingMutable } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useIsDesktop } from '@/app/useMediaQuery';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { ensureImeFix } from './imeFix';
import { TmuxHelpModal } from './TmuxHelpModal';
import { FsBrowser } from '../files/FsBrowser';
import {
  reduceTermFocus,
  initialTermFocusState,
  type TermFocusState,
  type TermFocusEvent,
  type TermFocusAction,
} from './termFocusPolicy';
import { createTermWriteHold } from './termWriteHold';
import { createTermStreamSync } from './termStreamSync';
import {
  createViewportStabilizer,
  computeKbAvail,
  pickTermTypography,
  MOBILE_TYPO_BASE,
  type TermTypography,
} from './termKbViewport';
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

// Console-token-derived xterm theme. Hardcoded hexes, NOT CSS vars — xterm
// paints from these strings directly and can't resolve var() (same reason as
// TERM_FONT below). Values map to src/styles/tokens.css; keep in sync:
//   background = --term-bg (dark --bg-0: the terminal is the floor, both themes)
//   foreground/brightWhite = --text · brightBlack = --text-faint
//   red = --danger · yellow = --warn · cyan = --accent (phosphor teal IS our
//   cyan — the one identity mapping; green stays a REAL green so TUIs keep
//   their success-vs-live distinction) · cursor = --accent on --accent-ink.
// All non-dim colors clear WCAG AA (≥4.5:1) on #06080C; brightBlack is the
// conventional "dim" slot (= --text-faint) and is exempt by design.
const THEME = {
  background: '#06080C', foreground: '#E8EDF4',
  cursor: '#34E2C4', cursorAccent: '#04110E',
  selectionBackground: 'rgba(52,226,196,0.24)',
  selectionInactiveBackground: 'rgba(52,226,196,0.13)',
  black: '#10161F', brightBlack: '#5B6675',
  red: '#FF6B6B', brightRed: '#FF9B94',
  green: '#68D26E', brightGreen: '#8BE890',
  yellow: '#E6B450', brightYellow: '#F2C97D',
  blue: '#7AA2D6', brightBlue: '#9FC0EF',
  magenta: '#C792EA', brightMagenta: '#DDB3F8',
  cyan: '#34E2C4', brightCyan: '#7CEEDD',
  white: '#B7C2D0', brightWhite: '#E8EDF4',
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
  const [params, setSearchParams] = useSearchParams();
  const tid = params.get('tid') ?? undefined;
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { t } = useTranslation();
  const settings = useSettings();
  const terminals = useTerminalSessions((s) => s.terminals);
  const renameTerminal = useTerminalSessions((s) => s.rename);
  const meta = terminals.find((x) => x.id === tid);
  const title = meta?.title || meta?.machineName || t('newSessionModal.terminalTitle');

  // Latest synced startup command, readable inside the terminal effect without
  // adding `settings` to its deps (that would tear down a live terminal on any
  // settings change). Sent with the initial open only; the DAEMON decides
  // whether this open actually creates the tmux session (→ run it) or merely
  // reattaches (→ never re-run) — the client can't know which it is.
  const startupCommandRef = useRef(settings.terminalStartupCommand);
  startupCommandRef.current = settings.terminalStartupCommand;

  // `fresh=1` marks the ONE navigation allowed to CREATE the tmux session
  // (the new-terminal flow that just made the optimistic row). Every other
  // mount — sidebar/palette navigation, a refresh on this URL, catch-up
  // resubscribes — opens attach-only, so a deleted terminal can't be
  // resurrected by its own screen. The param is stripped (history replace)
  // once the create-open succeeds; read via a ref so the strip doesn't
  // retrigger the terminal effect.
  const freshRef = useRef(false);
  freshRef.current = params.get('fresh') === '1';
  const clearFreshRef = useRef(() => {});
  clearFreshRef.current = () => {
    if (params.get('fresh') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('fresh');
    setSearchParams(next, { replace: true });
  };

  const hostRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalRenderer | null>(null);
  // Bridge the effect-local sendInput (base64 → socket, honours encryption) out
  // to the assistive key bar handlers below, which live outside the effect.
  const sendInputRef = useRef<((d: string) => void) | null>(null);
  // Bridge the effect-local output write-hold (freeze/flush) out to the mobile
  // select-mode toggle, so entering select-mode freezes the screen for stable
  // native text selection and leaving it flushes buffered output.
  const writeHoldRef = useRef<{ begin: () => void; flush: () => void } | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  // File browser drawer (fs-list / fs-read RPCs). Overlay, not an inline
  // sidebar — opening it must NOT resize the terminal (a refit would trigger
  // the whole rows-change → resize-RPC → tmux-reflow chain for nothing).
  // Mounted only while open, so FsBrowser picks up the freshest pushed cwd.
  const [filesOpen, setFilesOpen] = useState(false);
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

  // Line-input mode (mobile): compose whole lines in a plain textarea below
  // the key bar instead of per-key input — see TermInputBar. Device-local
  // preference (phone vs desktop is an input-hardware trait, not an account
  // trait); remembered across sessions.
  const [inputBarMode, setInputBarMode] = useLocalSettingMutable('terminalInputBarMode');

  // ── Mobile focus/keyboard policy ──────────────────────────────────────────
  // Pure state machine (see ./termFocusPolicy): decides whether taps / key-bar
  // keys / snippets may (re)focus the terminal — i.e. whether the soft keyboard
  // comes up. Core invariant: after the user explicitly dismisses the keyboard
  // (hide-keyboard key, OS Done key, focus lost for good), nothing auto-
  // refocuses until the next explicit tap on the terminal body. All state in
  // refs: it's consulted from stable event listeners inside the effect.
  // barMode seeds from the remembered device preference (localSettings loads
  // synchronously at store creation, so first render sees the real value).
  const focusStateRef = useRef<TermFocusState>({
    ...initialTermFocusState,
    barMode: IS_COARSE_POINTER && inputBarMode === true,
  });
  // Layout restore (clear maxHeight + refit + un-pan the page), bridged out of
  // the effect so the policy dispatcher below can trigger it.
  const restoreLayoutRef = useRef<(() => void) | null>(null);
  // The line-input bar's textarea (input-bar mode) + the bottom-bars wrapper
  // (key bar + input bar) whose height the keyboard-avoidance math reserves.
  const inputBarRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomBarsRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const runFocusAction = (a: TermFocusAction) => {
    switch (a) {
      case 'focus-terminal':
        termRef.current?.focus();
        break;
      case 'focus-input-bar':
        inputBarRef.current?.focus();
        break;
      case 'blur-input-bar':
        inputBarRef.current?.blur();
        break;
      case 'blur-all': {
        const tm = termRef.current;
        tm?.blur?.();
        (tm?.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null)?.blur();
        inputBarRef.current?.blur();
        break;
      }
      case 'restore-layout':
        restoreLayoutRef.current?.();
        break;
      case 'none':
        break;
    }
  };
  const dispatchFocus = (e: TermFocusEvent): TermFocusAction => {
    const { state, action } = reduceTermFocus(focusStateRef.current, e);
    focusStateRef.current = state;
    runFocusAction(action);
    return action;
  };

  // Toggle per-key ↔ line-input mode. flushSync: the policy's focus action
  // needs the target element MOUNTED (entering renders the input bar) and must
  // run inside this click's gesture stack — iOS only opens the soft keyboard
  // for focus() calls made synchronously within a user gesture.
  const toggleInputBarMode = () => {
    const next = !focusStateRef.current.barMode;
    flushSync(() => setInputBarMode(next));
    dispatchFocus({ type: 'toggle-bar-mode' });
  };

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
    // to every output chunk; `sync` (see ./termStreamSync.ts for the full
    // failure-mode write-up) tracks the highest seq applied so a catch-up can
    // ask for `fromSeq=lastSeq`, dedups replay/live overlap, refuses to write
    // across a hole (a lost chunk desyncs xterm from tmux's delta redraws →
    // ghost chars / stale regions), and — critically — RESETS the baseline on
    // a snapshot, because the daemon restarts a recreated session's seq at 0
    // and the old Math.max baseline then silently dropped ALL further output
    // (frozen screen, no echo).
    const sync = createTermStreamSync();
    // Chunks that arrive before the open RPC resolves. We can't attribute them
    // yet (a NEW terminal's id is assigned by the daemon, and the RPC ack's
    // payload decrypt is async, so socket events can be processed first) —
    // dropping them was a real race: the daemon computes the open snapshot,
    // then streams chunks immediately, and losing those first redraw deltas
    // left the screen stuck on pre-switch content. Bounded; a dropped overflow
    // surfaces as a seq gap after the flush and heals via catchUp.
    const EARLY_OUTPUT_MAX = 512;
    let earlyOutput: Array<{ terminalId: string; data: string; seq?: number; enc?: boolean }> | null = [];

    // ── Selection write-hold ─────────────────────────────────────────────────
    // While the user is drag-selecting (or mobile select-mode is on), incoming
    // output is BUFFERED instead of written — see ./termWriteHold.ts for the
    // full mechanism write-up AND the release-path regression story (a stuck
    // hold froze all output after a right-click: the macOS context menu opens
    // at mousedown and swallows the mouseup, which made typed CJK never echo —
    // "中文输入法没法用"). The extracted state machine owns every release path;
    // this effect only feeds it events (mouse handlers + sendInput below).
    const writeHold = createTermWriteHold((d) => term.write(d));
    const gatedWrite = writeHold.gatedWrite;

    // Apply one output chunk: seq bookkeeping SYNCHRONOUSLY (so chunks arriving
    // during an async decrypt still dedup against the right baseline), write
    // queued on outChain. 'gap' chunks are NOT written — writing across a hole
    // tears escape sequences and permanently desyncs xterm from tmux's delta
    // redraws (ghost characters backspace can never remove) — the catch-up
    // replays the hole from the daemon's ring instead.
    const applyLiveChunk = (e: { data: string; seq?: number; enc?: boolean }) => {
      const decision = sync.liveChunk(e.seq);
      if (decision === 'dup') return;
      if (decision === 'gap') { catchUp(); return; }
      if (e.enc) {
        outChain = outChain.then(async () => {
          const plain = await decryptTerminalData(machineId, e.data);
          if (plain && !disposed) gatedWrite(b64ToBytes(plain));
        });
      } else {
        gatedWrite(b64ToBytes(e.data));
      }
    };
    const onOutput = (e: { terminalId: string; data: string; seq?: number; enc?: boolean }) => {
      if (disposed) return;
      if (!terminalId) {
        // Open still in flight — stash instead of dropping (see earlyOutput).
        if (earlyOutput && earlyOutput.length < EARLY_OUTPUT_MAX) earlyOutput.push(e);
        return;
      }
      if (e.terminalId !== terminalId) return;
      applyLiveChunk(e);
    };
    const onExit = (e: { terminalId: string; exitCode?: number }) => {
      if (disposed || e.terminalId !== terminalId) return;
      term.writeln(`\r\n\x1b[38;2;91;102;117m[process exited${e.exitCode != null ? ` (${e.exitCode})` : ''}]\x1b[0m`);
    };
    apiSocket.onMessage('terminal-output', onOutput);
    apiSocket.onMessage('terminal-exit', onExit);

    const sendInput = (d: string) => {
      // Release a stuck gesture write-hold: if a lost mouseup left output
      // frozen, the user's own input (keystroke, IME commit, paste) must not
      // have its echo invisibly swallowed. No-op mid-normal-click (mouseup
      // flushes first) and for the mobile select-mode hold.
      writeHold.noteUserInput();
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

    // ── Mobile soft-keyboard input bridge (coarse pointer only) ─────────────
    // v2 diff-engine bridge — see ./mobileInputBridge.ts for the full mechanism
    // write-up (why v1's "send per inputType + clear the textarea" double-sent
    // deletes via xterm's _handleAnyTextareaChanges, desynced the OS keyboard's
    // view of the field, and could strand an undeletable last letter). Installed
    // after term.open (below, in the IS_COARSE_POINTER block).
    let mobileBridge: ReturnType<typeof installMobileInputBridge> = null;
    let imeGuard: ReturnType<typeof installImeStuckGuard> = null;

    // FALLBACK auto-title from the first typed line — plain-shell terminals
    // only. The PRIMARY auto-title is the daemon following the pane's OSC
    // title into @vh_title (Claude Code's TUI sets it to a live task summary;
    // the daemon push carries it back). This onKey capture only makes sense
    // when the first Enter really submits a SHELL COMMAND; with a startup
    // command configured the terminal boots straight into claude and the first
    // typed line is the user's first PROMPT (long/CJK/noise) — skip it there
    // and let the daemon title it. A shell's own pane_title is just the
    // hostname (filtered by the daemon), so this fallback still owns the
    // pure-shell case. `ifAbsent` + no manual flag on the daemon side keep it
    // overridable by the pane-title follow if claude starts later.
    const keyDisp = term.onKey(({ key, domEvent }) => {
      if (titled) return;
      if (startupCommandRef.current?.trim()) { titled = true; return; }
      if (domEvent.key === 'Enter') {
        const tt = titleBuf.trim();
        if (tt && tid) {
          // ifAbsent write to the machine only — the confirming daemon push
          // carries the title back (an optimistic local value could disagree
          // with what ifAbsent actually kept).
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
    //
    // Keyboard-animation gate: while the soft keyboard is sliding (kbStabilizer
    // burst in flight), the per-frame maxHeight updates fire the ResizeObserver
    // every frame — refitting on each one stacked 5-8 full reflow chains
    // (fit → rows change → terminal-resize RPC → tmux reflow) inside one
    // 250ms animation = the first-open judder. During the burst refits are
    // suppressed; the stabilizer's onStable runs exactly one (kbStableFit,
    // defined with the viewport handlers below). Desktop never has a burst.
    let fitRaf = 0;
    const kbStabilizer = createViewportStabilizer({ onStable: () => kbStableFit() });
    const scheduleFit = () => {
      if (kbStabilizer.pending()) return;
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
    // Becoming visible again (tab switch, or mobile screen unlock) → re-fit,
    // refocus (desktop), and catch up any output missed while hidden. catchUp
    // is defined below in the same effect scope; onVisible only runs on events,
    // long after the effect body (and catchUp) has initialized.
    const onVisible = () => { if (!document.hidden) { scheduleFit(); refocus(); catchUp(); } };
    document.addEventListener('visibilitychange', onVisible);
    // bfcache restore (iOS Safari commonly restores from bfcache on unlock and
    // fires pageshow rather than visibilitychange) → same catch-up path.
    const onPageShow = () => { if (!document.hidden) { scheduleFit(); catchUp(); } };
    window.addEventListener('pageshow', onPageShow);
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

    // Digest an open-terminal result: ALL seq bookkeeping happens synchronously
    // here (so live chunks racing the restore dedup against the right
    // baseline), and the returned closure performs the actual screen writes —
    // the caller decides where it runs (initial open queues it on outChain;
    // catchUp awaits it inside its own outChain slot so it lands BEFORE any
    // live-chunk writes queued while the RPC was in flight). `seqAtCall` is
    // the baseline when the RPC was issued — see termStreamSync.snapshotApplied
    // for why a snapshot ASSIGNS the baseline instead of maxing it (a daemon-
    // side session recreation restarts seq at 0; maxing froze the terminal).
    const applyOpenResult = (
      res: Extract<Awaited<ReturnType<typeof machineOpenTerminal>>, { success: true }>,
      seqAtCall: number,
    ): (() => Promise<void>) => {
      const writeMaybeEnc = async (dataB64: string) => {
        if (res.encStream) {
          const plain = await decryptTerminalData(machineId, dataB64);
          if (plain && !disposed) gatedWrite(b64ToBytes(plain));
        } else {
          gatedWrite(b64ToBytes(dataB64));
        }
      };
      if (res.mode === 'snapshot') {
        sync.snapshotApplied(res.seq, seqAtCall);
        return async () => {
          // A full restore replaces the screen — drop any drag-held chunks
          // (they predate the snapshot) and write directly. If mobile
          // select-mode is holding output, the hold re-arms AFTER the one-shot
          // restore (handled inside termWriteHold): the mode exists to freeze
          // the screen for native text selection, and a reconnect/visibility
          // snapshot must not silently unfreeze the live stream mid-selection
          // (the snapshot itself is fine — it's a single atomic replace, not a
          // running stream).
          writeHold.beginSnapshotRestore();
          term.reset();
          await writeMaybeEnc(res.data);
          writeHold.endSnapshotRestore();
        };
      }
      // Replay: apply only chunks newer than what we already have (decided
      // NOW, against the current baseline); then the daemon's reported seq
      // covers anything the replay didn't include.
      const fresh = res.chunks.filter((c) => sync.replayChunk(c.seq));
      sync.replayDone(res.seq);
      return async () => {
        for (const c of fresh) await writeMaybeEnc(c.data);
      };
    };

    // Catch up to the daemon's authoritative screen by re-subscribing with
    // fromSeq=lastSeq (→ replay the gap, or a fresh snapshot if it scrolled out
    // of the ring). Called whenever we might have missed live output: socket
    // reconnect AND tab becoming visible again. The visibility trigger is the
    // fix for mobile screen-lock: the socket often "recovers" silently on
    // unlock WITHOUT firing onReconnected (same socket.io quirk we hit on the
    // chat side), so a visibility-driven catch-up is what actually refreshes a
    // stale terminal on return. Idempotent: in-flight guard + seq dedup make
    // overlapping triggers (visible + reconnected firing together) harmless; if
    // the socket isn't back yet the RPC just fails and the next trigger retries.
    // `catchUpAgain` replaces silent coalescing: a trigger landing while a
    // catch-up is already in flight (e.g. a gap chunk whose hole the in-flight
    // response was computed too early to cover) queues exactly one follow-up
    // run, so the resync converges instead of stranding the miss until the
    // next unrelated trigger.
    let catchingUp = false;
    let catchUpAgain = false;
    // The daemon said the terminal no longer exists (deleted on another
    // device / expired): stop every further catch-up — retrying can't bring
    // it back, and on an old create-or-attach daemon it would RECREATE it.
    let gone = false;
    const onGone = () => {
      gone = true;
      if (tid) useTerminalSessions.getState().remove(tid);
      // Raw (unlocalized) line, same style as shell output/daemon errors.
      term.writeln('\r\n\x1b[38;2;255;107;107m✗ terminal no longer exists on this machine\x1b[0m');
    };
    const catchUp = (opts?: { forceSnapshot?: boolean }) => {
      if (disposed || gone || !terminalId) return;
      if (catchingUp) { catchUpAgain = true; return; }
      catchingUp = true;
      outChain = outChain.then(async () => {
        try {
          const seqAtCall = sync.lastSeq;
          const res = await machineOpenTerminal(machineId, {
            terminalId, cols: term.cols, rows: term.rows,
            // forceSnapshot (the blank-screen belt) omits fromSeq so the daemon
            // must send a full snapshot rather than an (empty-looking) replay.
            fromSeq: opts?.forceSnapshot ? undefined : seqAtCall,
            encStream: true,
            // Catch-up, not a new viewer: don't inflate the daemon's
            // subscriber count (the mount-time open below already counted us).
            // Implies attach-only on daemons >= 0.2.29 — a catch-up must never
            // recreate a tmux session that was killed while we were away.
            resub: true,
            attachOnly: true,
          });
          if (disposed) return;
          if (!res.success) {
            if (res.gone) onGone();
            return;
          }
          enc = res.encStream === true;
          tmuxAttached = !!res.tmuxSession;
          // Restore runs INSIDE this outChain slot: live chunks that arrived
          // during the RPC queued their writes after it, and their seqs were
          // accepted after seqAtCall so the snapshot baseline keeps them.
          await applyOpenResult(res, seqAtCall)();
          apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
        } finally {
          catchingUp = false;
          if (catchUpAgain && !disposed) { catchUpAgain = false; catchUp(); }
        }
      });
    };

    // ── tmux-native scrollback (wheel / touch scroll) ────────────────────────
    // Verified mechanism (pty probe + xterm 5.5 src): the daemon's pty runs
    // `tmux attach`, and tmux switches the OUTER terminal to the ALTERNATE
    // screen (\x1b[?1049h) for its whole life. In the alt buffer xterm has no
    // scrollback (`buffer.hasScrollback === false`), so Terminal._bindMouse
    // converts every wheel tick into Up/Down ARROW KEYS sent to the pty — the
    // shell cycles command history, nothing scrolls, and (bonus bug) each tick
    // counts as user input, which CLEARS any selection. The `scrollback: 5000`
    // renderer option only ever applies to the no-tmux fallback shell.
    // Fix: intercept the wheel while the alt buffer is active and drive tmux's
    // own scrollback through a daemon RPC (`terminal-scroll`): enter copy-mode
    // (-e → auto-exits at bottom) and scroll-up/down; panes whose INNER app is
    // fullscreen (vim/less, `alternate_on`) get arrow keys instead — the same
    // semantics tmux itself applies for mouse wheels. While in copy-mode tmux
    // freezes the view on new output, so "reading scrolled-back content" is
    // stable by construction. Wheel batching keeps the RPC rate sane.
    //
    // Scroll-RPC health: a failed call is usually TRANSIENT (socket blip,
    // daemon restarting, RPC timeout) — the daemon's error strings aren't a
    // stable API for telling "method missing" apart from "unreachable right
    // now", so instead of disabling scrolling forever on the first error we
    // back off for a TTL and retry; only a streak of consecutive failures
    // (genuinely old daemon without the handler) disables it for this mount,
    // falling back to xterm's default wheel behavior.
    const SCROLL_RPC_RETRY_MS = 30_000;
    const SCROLL_RPC_MAX_FAILS = 3;
    let tmuxAttached = false;
    let scrollRpcDeadUntil = 0;
    let scrollRpcFails = 0;
    const scrollRpcDown = () =>
      scrollRpcFails >= SCROLL_RPC_MAX_FAILS || Date.now() < scrollRpcDeadUntil;
    const noteScrollRpcFailure = () => {
      scrollRpcFails += 1;
      scrollRpcDeadUntil = Date.now() + SCROLL_RPC_RETRY_MS;
    };
    let wheelAccum = 0;
    let wheelFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollInFlight = false;
    const flushWheel = () => {
      wheelFlushTimer = null;
      const lines = Math.trunc(wheelAccum);
      if (lines === 0 || disposed || !terminalId || scrollRpcDown()) return;
      if (scrollInFlight) { scheduleWheelFlush(); return; }
      wheelAccum -= lines;
      scrollInFlight = true;
      machineScrollTerminal(machineId, terminalId, lines)
        .then((ok) => {
          if (ok) { scrollRpcFails = 0; scrollRpcDeadUntil = 0; }
          else noteScrollRpcFailure();
        })
        .catch(() => noteScrollRpcFailure())
        .finally(() => {
          scrollInFlight = false;
          if (Math.trunc(wheelAccum) !== 0) scheduleWheelFlush();
        });
    };
    const scheduleWheelFlush = () => {
      if (wheelFlushTimer == null) wheelFlushTimer = setTimeout(flushWheel, 60);
    };
    term.attachCustomWheelEventHandler((ev) => {
      if (!tmuxAttached || scrollRpcDown() || !terminalId) return true;
      if (term.buffer.active.type !== 'alternate') return true; // normal buffer → native scrollback
      if (ev.deltaY === 0 || ev.shiftKey) return true;
      const termEl = term.element;
      const rowH = Math.max(6, (termEl?.clientHeight ?? mount.clientHeight) / Math.max(1, term.rows));
      const dLines = ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? ev.deltaY
        : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE ? ev.deltaY * term.rows
        : ev.deltaY / rowH;
      // RPC contract: lines > 0 scrolls UP (into history); wheel-up is deltaY<0.
      wheelAccum += -dLines;
      scheduleWheelFlush();
      ev.preventDefault();
      return false; // handled — don't let xterm synthesize arrow keys
    });

    // Blank-screen belt (defense in depth behind the seq fixes): if the mount's
    // restore left the screen with NO text at all while the daemon reports a
    // live tmux session, something upstream returned an empty snapshot (e.g. a
    // just-recreated session whose tmux attach repaint got lost) — force one
    // full re-snapshot. tmux always paints a status line, so an attached
    // session is never legitimately all-blank for long.
    let blankCheckTimer: ReturnType<typeof setTimeout> | null = null;
    const isScreenBlank = () => {
      const buf = term.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (line && line.translateToString(true).trim().length > 0) return false;
      }
      return true;
    };

    // Open (first subscribe): no fromSeq → the daemon returns a fresh snapshot.
    (async () => {
      safeFit();
      const isFresh = freshRef.current;
      const res = await machineOpenTerminal(machineId, {
        terminalId: tid, cols: term.cols, rows: term.rows, encStream: true,
        // Runs only if the daemon CREATES the session (see startupCommandRef).
        startupCommand: startupCommandRef.current,
        // Only the fresh-create navigation may create the tmux session; any
        // other mount (sidebar nav, URL refresh) attaches to what exists —
        // a deleted terminal's stale URL must not resurrect it (>= 0.2.29;
        // older daemons keep create-or-attach).
        attachOnly: !isFresh,
      });
      if (disposed) return;
      if (!res.success) {
        earlyOutput = null; // nothing will ever consume the stash
        if (res.gone) {
          onGone();
        } else {
          term.writeln(`\x1b[38;2;255;107;107m✗ ${res.error}\x1b[0m`);
        }
        setConnecting(false);
        return;
      }
      // The create intent was consumed — strip `fresh` from the URL so a
      // later refresh of this tab re-attaches instead of re-creating.
      if (isFresh) clearFreshRef.current();
      terminalId = res.terminalId;
      enc = res.encStream === true;
      tmuxAttached = !!res.tmuxSession;
      // Seq bookkeeping is synchronous in applyOpenResult; the restore itself
      // is serialized behind outChain so any live chunk arriving mid-restore
      // is applied after it (and seq-deduped), never interleaved.
      outChain = outChain.then(applyOpenResult(res, 0));
      // Flush chunks that raced the open (see earlyOutput): emitted by the
      // daemon right after it computed the snapshot, but processed here before
      // terminalId was known. They funnel through the normal seq rules, and
      // their writes queue AFTER the restore above — order preserved.
      const stashed = earlyOutput ?? [];
      earlyOutput = null;
      for (const e of stashed) {
        if (e.terminalId === terminalId) applyLiveChunk(e);
      }
      setConnecting(false);
      requestAnimationFrame(doFit);
      // Don't steal focus from the line-input bar (input-bar mode): this runs
      // async after mount, and the bar may already own the keyboard.
      if (!(IS_COARSE_POINTER && focusStateRef.current.barMode)) term.focus();
      // Arm the blank-screen belt once the restore (and stash flush) has been
      // written; give late tmux-attach repaint chunks a moment to land first.
      outChain = outChain.then(() => {
        if (disposed || !res.tmuxSession) return;
        blankCheckTimer = setTimeout(() => {
          blankCheckTimer = null;
          if (disposed || !isScreenBlank()) return;
          catchUp({ forceSnapshot: true });
        }, 800);
      });
    })();

    // On socket reconnect (dropped then back), re-subscribe with fromSeq=lastSeq.
    // The daemon replays just the missed output, or resends a snapshot if the
    // gap scrolled out of its ring. Only fires once the initial open established
    // a terminalId (onReconnected also fires on the very first connect).
    const offReconnected = apiSocket.onReconnected(() => catchUp());

    const host = hostRef.current;
    // Upload files to the machine (→ ~/.happy/uploads/terminal/) and paste the
    // absolute paths at the cursor. Shared by drag-drop and clipboard paste.
    // term.paste() uses bracketed paste, so nothing auto-executes. Paths are
    // single-quoted; the daemon sanitizes names to [\w.-] so no quoting edge.
    const uploadFilesToTerminal = async (files: File[]) => {
      for (const f of files) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const r = await machineUploadFile(machineId, f.name || 'file', btoa(bin));
        if (r.success && r.path && !disposed) term.paste(`'${r.path}' `);
      }
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); host.classList.add('is-dragover'); };
    const onDragLeave = () => host.classList.remove('is-dragover');
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); host.classList.remove('is-dragover');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void uploadFilesToTerminal(files);
    };
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);
    // ⌘V with FILES on the clipboard (screenshot, Finder copy): upload instead
    // of pasting garbage. Capture phase on the host runs before xterm's own
    // 'paste' listener on the textarea (ancestor capture precedes target), so
    // we can consume file pastes while leaving plain-text paste to xterm's
    // native bracketed-paste path untouched. Clipboard image files are all
    // named "image.png" — prefix a timestamp so successive pastes don't
    // overwrite each other on the machine.
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return; // text paste → xterm handles it
      e.preventDefault();
      e.stopImmediatePropagation();
      const stamped = files.map((f) => new File([f], `paste-${Date.now().toString(36)}-${f.name || 'file'}`, { type: f.type }));
      void uploadFilesToTerminal(stamped);
    };
    host.addEventListener('paste', onPaste, true);

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
      // A tap is the ONE explicit gesture that may summon the keyboard — route
      // it through the focus policy (it also clears a prior dismissal). The
      // resulting term.focus() still runs synchronously inside this touchend
      // (iOS only opens the keyboard inside the user-gesture call stack). In
      // input-bar mode the same tap instead blurs the bar (tap output = "let
      // me read", normal web semantics).
      if (dx * dx + dy * dy <= 12 * 12) dispatchFocus({ type: 'tap' });
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
    // viewport portion MINUS the bottom bars (key bar / line-input bar), so the
    // bars themselves stay visible above the keyboard.
    //
    // The keyboard open/close is an ANIMATION and vv fires resize on many of
    // its frames. Per frame only CHEAP work runs: the CSS maxHeight tracks the
    // keyboard (bars stay visible, no transition — a lagging host would leave
    // the bars underneath the rising keyboard), plus the `is-kb` compaction
    // class (pure CSS, slims the bars). The EXPENSIVE chain — FitAddon refit →
    // rows change → terminal-resize RPC → tmux reflow — runs ONCE per burst in
    // kbStableFit (scheduleFit is gated on the stabilizer above): that chain
    // running on every animation frame was the first-open judder.
    //
    // Layout RESTORE runs on two channels, because the visualViewport one alone
    // is not reliable on iOS:
    //  1. onViewport: vv.height back to ≈ window.innerHeight. Under the iOS
    //     standalone-PWA "viewport shrinks for good" bug, innerHeight itself
    //     has shrunk and this condition NEVER becomes true again → the old
    //     maxHeight stuck forever ("keyboard closed but layout never came back").
    //  2. focusout: the helper textarea (or input bar) lost focus and — probed
    //     one tick later — focus didn't land on another keyboard-owning element
    //     of this screen. Focus gone ⇒ keyboard gone (the keyboard exists only
    //     while an editable is focused), regardless of what the viewport claims.
    // Both funnel into restoreLayout(), which also un-pans the page: iOS pans
    // the layout viewport to reveal the focused field and routinely leaves the
    // scroll offset behind after the keyboard closes.
    const vv = window.visualViewport;
    let kbLayoutActive = false; // we shrank the host for the keyboard
    // Keyboard-state typography (coarse only): small viewports drop to compact
    // type for 2-3 extra rows. Setting term.options re-measures cell metrics,
    // so only write on an actual change.
    const applyTypography = (typo: TermTypography): void => {
      if (term.options.fontSize === typo.fontSize && term.options.lineHeight === typo.lineHeight) return;
      term.options.fontSize = typo.fontSize;
      term.options.lineHeight = typo.lineHeight;
    };
    const setKbClass = (on: boolean) => screenRef.current?.classList.toggle('is-kb', on);
    // Per-frame (cheap): follow the keyboard with CSS only. Returns whether the
    // keyboard layout is engaged (avail can be ≤60 mid-animation on tiny
    // landscape viewports — then leave the layout alone, same as before).
    const applyKbMaxHeight = (): void => {
      if (!vv) return;
      const avail = computeKbAvail({
        vvHeight: vv.height,
        vvOffsetTop: vv.offsetTop,
        hostTop: host.getBoundingClientRect().top,
        barsHeight: bottomBarsRef.current?.offsetHeight ?? 0,
      });
      if (avail > 60) {
        kbLayoutActive = true;
        host.style.maxHeight = `${avail}px`;
      }
    };
    // Once per burst (expensive): final typography + final maxHeight (the
    // is-kb bar slimming and a typography change both move the numbers), ONE
    // fit + resize RPC, then pin the view to the bottom — rows just shrank,
    // and in a normal-buffer shell xterm can be left mid-scrollback with the
    // prompt (Claude's input line) below the fold. scrollToBottom is a no-op
    // in the tmux alt buffer (no scrollback there).
    function kbStableFit() {
      if (disposed || !kbLayoutActive || !vv) return;
      applyTypography(pickTermTypography(vv.height));
      applyKbMaxHeight();
      doFit();
      term.scrollToBottom();
    }
    const restoreLayout = () => {
      kbStabilizer.cancel(); // close animation ends here; nothing left to fit
      setKbClass(false); // before the guard: a tiny-viewport burst can set the
      // class without ever engaging maxHeight (avail ≤ 60)
      if (!kbLayoutActive && !host.style.maxHeight) return;
      kbLayoutActive = false;
      applyTypography(MOBILE_TYPO_BASE);
      host.style.maxHeight = '';
      scheduleFit();
      window.scrollTo({ top: 0 });
    };
    restoreLayoutRef.current = restoreLayout;
    const onViewport = () => {
      if (!vv) return;
      // Pinch zoom also shrinks vv.height — that's not a keyboard; leave the
      // layout alone (and don't fight the user's pan with scrollTo).
      if ((vv.scale ?? 1) > 1.001) return;
      if (vv.height >= window.innerHeight - 50) {
        // Keyboard dismissed (viewport ≈ full window) → restore natural layout.
        restoreLayout();
        return;
      }
      setKbClass(true);
      applyKbMaxHeight();
      kbStabilizer.sample(vv.height);
    };
    // Restore channel 2: focus left this screen's keyboard owners. Listened on
    // the screen root (capture-free — focusout bubbles) so it covers both the
    // xterm helper textarea and the line-input bar. The probe is DEFERRED:
    // focusout fires before the next element receives focus, so activeElement
    // is only meaningful a tick later (80ms also comfortably covers iOS timing).
    const settleTimers = new Set<ReturnType<typeof setTimeout>>();
    const onScreenFocusOut = () => {
      const timer = setTimeout(() => {
        settleTimers.delete(timer);
        if (disposed) return;
        const ae = document.activeElement;
        const target =
          ae && ae.classList?.contains('xterm-helper-textarea') ? 'terminal'
          : ae && bottomBarsRef.current?.contains(ae) ? 'input-bar'
          : 'none';
        // 'none' ⇒ keyboard is gone: mark dismissed (no auto-refocus until the
        // next tap) + restore the layout. Other targets are no-ops.
        dispatchFocus({ type: 'focus-settled', target });
      }, 80);
      settleTimers.add(timer);
    };
    const screenEl = screenRef.current;
    if (IS_COARSE_POINTER) {
      host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      // NOT passive: we preventDefault once a drag is classified as a scroll.
      host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      host.addEventListener('touchend', onTouchDone, { capture: true, passive: true });
      host.addEventListener('touchcancel', onTouchDone, { capture: true, passive: true });
      vv?.addEventListener('resize', onViewport);
      vv?.addEventListener('scroll', onViewport);
      screenEl?.addEventListener('focusout', onScreenFocusOut);
      // Install the v2 soft-keyboard bridge (diff engine, capture-phase on
      // term.element — see mobileInputBridge.ts). term.open already ran, so the
      // helper textarea exists.
      mobileBridge = installMobileInputBridge(term, sendInput);
    }

    // Desktop: click-to-focus fallback + copy-on-select + selection write-hold.
    // xterm only focuses its hidden textarea from its own internal mousedown
    // path — clicks landing on the host's padding (or after an odd focus loss)
    // miss it and typing goes nowhere until you hit the canvas exactly. A plain
    // click (tiny displacement, no selection) refocuses the terminal.
    //
    // Two selection fixes (both verified against xterm 5.5 src):
    //  1. mouseup is listened on the DOCUMENT, not the host: xterm's
    //     SelectionService finishes drags via document-level listeners, so a
    //     drag released OUTSIDE the terminal still produced a selection — but
    //     the old host-scoped listener never fired and the copy was silently
    //     skipped ("selected but nothing on the clipboard").
    //  2. output is HELD from mousedown to mouseup (gatedWrite above), so a
    //     busy TUI can't shift different text under the selection mid-drag.
    //     Copy happens BEFORE the flush, on the exact frozen content selected.
    let mouseX = 0;
    let mouseY = 0;
    let gestureFromHost = false;
    const onMouseDown = (e: MouseEvent) => {
      // Non-primary buttons never arm the gesture/hold: on macOS the NATIVE
      // context menu opens at right-mousedown and swallows the mouseup — an
      // armed hold would freeze all output until rescued (the "打不了中文"
      // regression: frozen echo with a working local pinyin bubble). A right
      // drag never selects anyway (rightClickSelectsWord acts at mousedown).
      if (e.button !== 0) return;
      mouseX = e.clientX; mouseY = e.clientY;
      gestureFromHost = true;
      writeHold.gestureStart(e.button);
    };
    const onDocMouseUp = (e: MouseEvent) => {
      if (!gestureFromHost) return;
      gestureFromHost = false;
      const dx = e.clientX - mouseX;
      const dy = e.clientY - mouseY;
      const dragged = dx * dx + dy * dy > 5 * 5;
      if (dragged && term.hasSelection()) {
        // Copy-on-select: mouseup is a user gesture, so writeText is allowed.
        // Keep the selection visible; don't steal focus. ⌘C/right-click still work.
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
      }
      // Resume output AFTER the copy so the clipboard got the frozen content.
      // (termWriteHold keeps holding if mobile select-mode owns a hold too.)
      writeHold.gestureEnd();
      if (dragged || term.hasSelection()) return;
      refocus(); // also clears a stuck IME composition, not just plain focus
    };
    // Safety: a drag released outside the browser window never fires mouseup —
    // don't leave output frozen. (Mobile select-mode intentionally keeps its
    // hold; it's released by the toggle.)
    const onWinBlur = () => {
      gestureFromHost = false;
      writeHold.gestureEnd();
    };
    // A context menu ends the gesture: once it's open the matching mouseup is
    // the menu's, not ours (platform-dependent whether the page ever sees it).
    const onCtxMenu = () => {
      gestureFromHost = false;
      writeHold.gestureEnd();
    };
    // Lost-mouseup rescue: the pointer moving with NO buttons pressed while a
    // gesture is still "active" means the mouseup happened where we couldn't
    // see it (native menu, OS dialog, browser chrome). Cheap: first check
    // bails when no gesture is in flight.
    const onDocMouseMove = (e: MouseEvent) => {
      if (!gestureFromHost || e.buttons !== 0) return;
      gestureFromHost = false;
      writeHold.gestureEnd();
    };
    if (!IS_COARSE_POINTER) {
      host.addEventListener('mousedown', onMouseDown, true);
      host.addEventListener('contextmenu', onCtxMenu, true);
      document.addEventListener('mouseup', onDocMouseUp, true);
      document.addEventListener('mousemove', onDocMouseMove, true);
      window.addEventListener('blur', onWinBlur);
      // Desktop IME stuck-composition guard: a macOS input-source switch
      // mid-composition can abort WITHOUT compositionend — xterm then swallows
      // every CJK-IME key ("只能英文输入") and the next English key commits the
      // aborted preedit as a stray letter. refocus()'s blur heal does NOT
      // reach this state (no browser composition → blur fires nothing); the
      // guard detects the sustained helper-vs-event contradiction on keydown
      // and resets helper FLAGS only — it never writes the textarea while
      // focused (a programmatic write under a live composition cancels it
      // eventlessly, i.e. manufactures the very stuck state). Residue is
      // cleared at blur, once the helper settles (desktop only —
      // mobileInputBridge OWNS the textarea model on coarse pointers).
      // Full failure-mode write-up in ./imeStuckGuard.ts.
      imeGuard = installImeStuckGuard(term);
    }
    // Mobile select-mode: freeze output for the whole mode — the mode exists
    // solely to let the OS long-press selection work on stable DOM text, and a
    // TUI repaint would destroy the native selection outright (row nodes are
    // replaced). Flushes on toggle-off; the safety cap in termWriteHold bounds
    // memory.
    writeHoldRef.current = {
      begin: () => writeHold.setModeHold(true),
      flush: () => writeHold.setModeHold(false),
    };

    return () => {
      disposed = true;
      clearTimeout(t0);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('focus', refocus);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      offReconnected();
      apiSocket.offMessage('terminal-output', onOutput);
      apiSocket.offMessage('terminal-exit', onExit);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
      host.removeEventListener('paste', onPaste, true);
      if (wheelFlushTimer != null) clearTimeout(wheelFlushTimer);
      if (blankCheckTimer != null) clearTimeout(blankCheckTimer);
      if (IS_COARSE_POINTER) {
        host.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchend', onTouchEnd, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchend', onTouchDone, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchcancel', onTouchDone, { capture: true } as EventListenerOptions);
        vv?.removeEventListener('resize', onViewport);
        vv?.removeEventListener('scroll', onViewport);
        screenEl?.removeEventListener('focusout', onScreenFocusOut);
        for (const timer of settleTimers) clearTimeout(timer);
        settleTimers.clear();
        kbStabilizer.cancel();
        screenEl?.classList.remove('is-kb');
        restoreLayoutRef.current = null;
        mobileBridge?.dispose();
        mobileBridge = null;
        host.style.maxHeight = '';
      }
      if (!IS_COARSE_POINTER) {
        host.removeEventListener('mousedown', onMouseDown, true);
        host.removeEventListener('contextmenu', onCtxMenu, true);
        document.removeEventListener('mouseup', onDocMouseUp, true);
        document.removeEventListener('mousemove', onDocMouseMove, true);
        window.removeEventListener('blur', onWinBlur);
        imeGuard?.dispose();
        imeGuard = null;
      }
      writeHoldRef.current = null;
      sendInputRef.current = null;
      dataDisp.dispose();
      keyDisp.dispose();
      if (terminalId) apiSocket.send('terminal-close', { machineId, terminalId });
      term.dispose();
      termRef.current = null;
    };
  }, [machineId, tid]);

  const runCommand = (command: string) => {
    const tm = termRef.current;
    if (!tm) return;
    tm.paste(command); // user presses Enter to run — never auto-execute
    // Mobile: route through the focus policy (explicit menu gesture → may
    // focus + clear a dismissal; in input-bar mode it leaves focus with the
    // bar). Desktop keeps the unconditional historical refocus.
    if (IS_COARSE_POINTER) dispatchFocus({ type: 'snippet' });
    else tm.focus();
  };

  // Shortcut (insert kind) → terminal input. Bracketed paste — never
  // auto-executes; the user presses Enter to send — with the text normalized
  // (see ./termPresetPaste) so a trailing newline can never double as an
  // auto-submit on paste paths without bracketed paste.
  const insertPreset = (text: string) => {
    const paste = presetPasteText(text);
    if (paste) runCommand(paste);
  };

  // Shortcut (run kind, run:true) → paste THEN execute. The paste lands via
  // xterm's synchronous onData → sendInput, so the trailing \r is sequenced
  // after the command text on the pty: inside a bracketed-paste TUI it
  // submits the pasted input; in a plain shell it runs the line. This is the
  // ONE path that auto-executes — the same entry picked from the chat
  // composer only inserts.
  const execPreset = (text: string) => {
    const paste = presetPasteText(text);
    if (!paste) return;
    runCommand(paste);
    sendInputRef.current?.('\r');
  };

  const onRename = async () => {
    if (!tid) return;
    const next = await Modal.prompt(t('common.rename'), undefined, { defaultValue: title });
    if (next != null) renameTerminal(tid, next);
  };

  const toggleSelectMode = () => {
    const next = !selectModeRef.current;
    selectModeRef.current = next;
    if (next) {
      // Freeze incoming output: a TUI repaint replaces the DOM row nodes and
      // would destroy the native long-press selection mid-gesture.
      writeHoldRef.current?.begin();
    } else {
      writeHoldRef.current?.flush();
    }
    // flushSync: leaving select mode re-mounts the bottom bars — the policy's
    // resulting focus action (e.g. focus-input-bar) needs them in the DOM, and
    // it must run inside this click's gesture stack for iOS to open the
    // keyboard. Entering dispatches blur-all (keyboard down for OS selection).
    flushSync(() => setSelectMode(next));
    dispatchFocus({ type: 'select-mode', on: next });
  };

  // Send raw bytes to the pty via the effect's sendInput (base64/encryption
  // aware). Whether the terminal is refocused afterwards (keeping the soft
  // keyboard up) is the focus policy's call: yes in normal per-key use, NO
  // after the user explicitly dismissed the keyboard (arrow keys with the
  // screen fully visible is a first-class TUI flow), and never in input-bar
  // mode (the bar keeps its own focus — its buttons preventDefault mousedown).
  const sendBytes = (bytes: string) => {
    sendInputRef.current?.(bytes);
    dispatchFocus({ type: 'bar-key' });
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

  return (
    <div className="term-screen" ref={screenRef}>
      <header className="term-header">
        {!isDesktop && (
          <button className="term-back" onClick={() => navigate('/')} aria-label="back">
            <ChevronLeft size={18} />
          </button>
        )}
        <button className="term-title" onClick={onRename} title={t('common.rename')}>
          <span className="term-title-text">{title}</span>
          <Pencil size={13} className="term-title-edit" />
        </button>
        <div className="term-header-right">
          {connecting && <span className="term-connecting mono">{t('common.loading')}</span>}
          {!isDesktop && (
            <button
              className={`sb-icon-btn${selectMode ? ' is-active' : ''}`}
              title={t('terminal.selectMode')}
              aria-pressed={selectMode}
              onClick={toggleSelectMode}
            >
              <TextSelect size={18} />
            </button>
          )}
          {/* Unified shortcuts (absorbed the old quick-commands menu):
              desktop entry lives here; touch devices get the key-bar entry
              instead (their keyboard affordances live there). */}
          {!IS_COARSE_POINTER && (
            <TermPresetsMenu
              variant="header"
              onPick={insertPreset}
              onRun={execPreset}
              onManage={() => navigateTo('/settings/snippets')}
              // Keyboard cancel (Esc / ⌘.) — back to the terminal, matching
              // where focus lived before the chord opened the menu.
              onCancel={() => termRef.current?.focus()}
            />
          )}
          <button
            className={`sb-icon-btn${filesOpen ? ' is-active' : ''}`}
            title={t('session.chat.files')}
            aria-pressed={filesOpen}
            onClick={() => setFilesOpen((v) => !v)}
          >
            <FolderOpen size={18} />
          </button>
          <button
            className="sb-icon-btn"
            title={t('tmuxHelp.title')}
            onClick={() => setShowHelp(true)}
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </header>
      <div ref={hostRef} className={`term-host${selectMode ? ' is-selecting' : ''}`}>
        {selectMode && <div className="term-select-hint mono">{t('terminal.selectModeHint')}</div>}
        <div ref={innerRef} className="term-host-inner" />
      </div>
      {IS_COARSE_POINTER && !selectMode && (
        <div className="term-bottombars" ref={bottomBarsRef}>
          <div className="term-keybar" role="toolbar" aria-label={t('terminal.keybarLabel')}>
            <button
              type="button"
              className="term-keybar-key term-keybar-sys"
              aria-label={t('terminal.hideKeyboard')}
              title={t('terminal.hideKeyboard')}
              // preventDefault keeps the focus where it is for the click's
              // duration; the policy then blurs everything explicitly (no
              // focus flicker through the button).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => dispatchFocus({ type: 'dismiss-key' })}
            >
              <KeyboardOff size={16} />
            </button>
            <button
              type="button"
              className={`term-keybar-key term-keybar-sys${inputBarMode ? ' is-armed' : ''}`}
              aria-pressed={inputBarMode}
              aria-label={t('terminal.inputBarToggle')}
              title={t('terminal.inputBarToggle')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleInputBarMode}
            >
              <TextCursorInput size={16} />
            </button>
            <TermPresetsMenu variant="keybar" onPick={insertPreset} onRun={execPreset} />
            <span className="term-keybar-sep" aria-hidden />
            <button
              type="button"
              className={`term-keybar-key term-keybar-mod${ctrlSticky ? ' is-armed' : ''}`}
              aria-pressed={ctrlSticky}
              aria-label="Control"
              // Don't blur the terminal (which would drop the soft keyboard).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setCtrlSticky((v) => !v); dispatchFocus({ type: 'bar-key' }); }}
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
          {inputBarMode && (
            <TermInputBar
              inputRef={inputBarRef}
              // Whole-line send: newlines (pasted multi-line) become CRs, plus
              // the terminating CR — the pty sees exactly what Enter would do.
              onSend={(text) => sendInputRef.current?.(toPtyText(text) + '\r')}
              onExit={toggleInputBarMode}
            />
          )}
        </div>
      )}
      {showHelp && <TmuxHelpModal onClose={() => setShowHelp(false)} />}
      {filesOpen && machineId && (
        <>
          {/* Scrim only materializes on narrow viewports (CSS) — desktop keeps
              the terminal interactive next to the drawer, like sd-files. */}
          <div className="term-files-scrim" onClick={() => setFilesOpen(false)} aria-hidden />
          <aside className="term-files">
            <div className="term-files-head">
              <span className="term-files-title">{t('session.chat.files')}</span>
              <button
                type="button"
                className="sb-icon-btn"
                onClick={() => setFilesOpen(false)}
                aria-label={t('session.chat.closeFiles')}
                title={t('session.chat.closeFiles')}
              >
                <X size={16} />
              </button>
            </div>
            {/* Start where the terminal lives: the pushed tmux pane cwd; a
                terminal without one (old daemon push) starts at home. */}
            <FsBrowser machineId={machineId} initialPath={meta?.cwd || '~'} />
          </aside>
        </>
      )}
    </div>
  );
}
