import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { createTerminalRenderer, type TerminalRenderer } from './renderer';
import { Pencil, HelpCircle, TextSelect, KeyboardOff, TextCursorInput, FolderOpen, MessagesSquare, StickyNote, X } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { apiSocket } from '@/sync/apiSocket';
import {
  machineOpenTerminal,
  encryptTerminalData,
  decryptTerminalData,
  machineSetTerminalTitle,
  machineScrollTerminal,
  machineTerminalPaste,
  machineTerminalHistory,
  type TerminalHistoryPage,
} from '@/sync/ops';
import { installMobileInputBridge, toPtyText } from './mobileInputBridge';
import { installImeStuckGuard } from './imeStuckGuard';
import {
  classifyFocusHolder,
  hasNonCollapsedSelection,
  hasOpenOverlay,
  installFocusOwnershipWatchdog,
  isOpenTerminalRoute,
  type FocusOwnershipInput,
  type FocusOwnershipWatchdog,
} from './termFocusOwnership';
import { installTermDiag } from './termDiag';
import { installTermInput, pickFieldPolicy, resolveInputOwnership } from './termInputHost';
import { installTermInputDiag } from './termInputDiag';
import { isTerminalInputElement } from './termInputElement';
import { TermInputBar } from './TermInputBar';
import { TermPresetsMenu } from './TermPresetsMenu';
import { presetPasteText } from './termPresetPaste';
import { onInsertToInput } from '@/app/insertToInput';
import { storage, useMachine, useSettings, useLocalSettingMutable } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { stampLocalActivity } from '@/sync/activityOverlayStore';
import { activityKeyForTerminal } from '@/sync/activityOverlay';
import { resumeStartupCommand } from '@/sync/closedTerminals';
import { useIsDesktop, useMediaQuery } from '@/app/useMediaQuery';
import { useFilesPanelWidth } from '../files/useFilesPanelWidth';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { ensureImeFix } from './imeFix';
import { TmuxHelpModal } from './TmuxHelpModal';
import { FsBrowser } from '../files/FsBrowser';
import {
  reduceTermFocus,
  initialTermFocusState,
  completeTerminalTouchTap,
  TERMINAL_TOUCH_END_OPTIONS,
  type TermFocusState,
  type TermFocusEvent,
  type TermFocusAction,
} from './termFocusPolicy';
import { resolveTerminalView, withTerminalViewOverride } from '@/sync/terminalViewPref';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { createTermWriteHold } from './termWriteHold';
import { createTermStreamSync } from './termStreamSync';
import { quoteTerminalUploadPath, terminalUploadName, uploadTerminalFile } from './terminalFileUpload';
import { useToast } from '@/ui';
import {
  createTermAssembly,
  prefixAlternateEnter,
  type AssemblyRebuildPlan,
} from './termAssembly';
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
const NEEDS_ZOOM_SAFE_INPUT = IS_COARSE_POINTER
  || (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 860px)').matches === true);

// Platform, for the key routing table only (mac's ⌥ is a third-level shift
// that PRODUCES characters — `∑` — while elsewhere Alt is a Meta prefix that
// must be VT-encoded as ESC+char, or readline's M-b/M-f go silently dead).
// Evaluated once: the keyboard doesn't change platform at runtime.
const IS_MAC =
  typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

export function WebTerminalScreen() {
  const { machineId } = useParams<{ machineId: string }>();
  const [params, setSearchParams] = useSearchParams();
  const tid = params.get('tid') ?? undefined;
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { t } = useTranslation();
  const toast = useToast();
  const machine = useMachine(machineId || '');
  const settings = useSettings();
  const terminals = useTerminalSessions((s) => s.terminals);
  const renameTerminal = useTerminalSessions((s) => s.rename);
  const meta = terminals.find((x) => x.id === tid);
  const title = meta?.title || meta?.machineName || t('newSessionModal.terminalTitle');

  // ── B-105 terminal mirror: xterm ↔ structured toggle ──────────────────────
  // The daemon pushes `mirrorSessionId` on terminals whose hand-launched
  // `claude` is being mirrored. The toggle is a plain ROUTE JUMP to the mirror
  // session (its banner jumps back) — deliberately not an in-page embed, so
  // this file's input/focus/layout machinery is untouched (the tmux session
  // stays alive; unmount/remount reattaches from the snapshot). Both
  // directions record a per-terminal override (M-3③).
  const mirrorSessionId = meta?.mirrorSessionId;
  const [viewDefault] = useLocalSettingMutable('terminalViewDefault');
  const [viewOverrides, setViewOverrides] = useLocalSettingMutable('terminalViewOverrides');
  const goStructured = () => {
    if (!tid || !mirrorSessionId) return;
    setViewOverrides(withTerminalViewOverride(viewOverrides, tid, 'structured'));
    navigate(`/session/${mirrorSessionId}`);
  };
  // Auto-open the structured face when the device preference resolves to it
  // (常驻结构化). Only within a short window after mount: the mirror id can
  // also APPEAR later (push lag, or claude launched minutes in) and a late
  // redirect would yank the user out of the terminal mid-typing.
  const mirrorMountAtRef = useRef(Date.now());
  const mirrorAutoRef = useRef(false);
  useEffect(() => {
    if (mirrorAutoRef.current || !tid || !mirrorSessionId) return;
    if (Date.now() - mirrorMountAtRef.current > 3000) return;
    mirrorAutoRef.current = true;
    if (resolveTerminalView(viewDefault, viewOverrides, tid) === 'structured') {
      navigate(`/session/${mirrorSessionId}`, { replace: true });
    }
  }, [tid, mirrorSessionId, viewDefault, viewOverrides, navigate]);
  // ───────────────────────────────────────────────────────────────────────────

  // Realtime sidebar ordering, layer 1 — the "I'm looking at this one" stamp.
  // Opening a terminal and having it on screen IS an interaction with it, even
  // before a key is pressed (reading a long agent turn is the common case), so
  // the row floats on arrival. Re-stamped when the tab comes back to the
  // foreground on this screen, so a terminal left open in a background tab
  // doesn't claim to be what you were just doing. Deliberately NOT on a timer:
  // a parked tab must not keep re-floating itself forever.
  useEffect(() => {
    if (!tid) return;
    const stamp = () => {
      if (document.hidden) return;
      stampLocalActivity(activityKeyForTerminal(tid));
    };
    stamp();
    document.addEventListener('visibilitychange', stamp);
    window.addEventListener('focus', stamp);
    return () => {
      document.removeEventListener('visibilitychange', stamp);
      window.removeEventListener('focus', stamp);
    };
  }, [tid]);

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
  // `cwd` rides along with `fresh` only (B-084 "new terminal in this
  // directory"): sent on the create-open, where the daemon's create path does
  // `tmux new-session -c <cwd>`; attach-only opens never send it, so a stale
  // URL can't redirect an existing terminal. Stripped together with `fresh`.
  const createCwdRef = useRef<string | undefined>(undefined);
  createCwdRef.current = params.get('cwd') || undefined;
  // `resume` (B-149): continue the claude conversation of a terminal that died
  // in a restart. Like `cwd` it rides the create-open only. The URL carries the
  // session ID, never a command — the command is rebuilt here after validation,
  // and it OVERRIDES the global startup command for this one open.
  const createResumeCmdRef = useRef<string | undefined>(undefined);
  createResumeCmdRef.current = resumeStartupCommand(params.get('resume') || undefined);
  const clearFreshRef = useRef(() => {});
  clearFreshRef.current = () => {
    if (params.get('fresh') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('fresh');
    next.delete('cwd');
    next.delete('resume');
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
  const [hasTmuxSession, setHasTmuxSession] = useState(false);
  // File browser drawer (fs-list / fs-read RPCs). Desktop (fine pointer,
  // >860px): an inline SPLIT — the terminal yields width instead of being
  // covered (B-088; the old always-overlay is kept on touch/narrow where the
  // drawer is a full/floating overlay anyway). Opening/closing/drag-resizing
  // the split changes the terminal container's width, so it rides the existing
  // ResizeObserver → scheduleFit → fit + terminal-resize RPC chain; during a
  // HANDLE DRAG that chain is suppressed (filesDragHoldRef) and exactly one
  // fit runs on release — per-frame refits re-ran the whole fit → resize-RPC →
  // tmux-reflow chain every mousemove (the historical first-open judder).
  // Mounted only while open, so FsBrowser picks up the freshest pushed cwd.
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileUpload, setFileUpload] = useState<{ name: string; sent: number; total: number } | null>(null);
  // Split mode matches the CSS: fine pointer AND >860px (see terminal.css
  // .term-mid / .term-files media rules — coarse or narrow keep the overlay).
  const filesSplit = useMediaQuery('(min-width: 861px) and (pointer: fine)');
  const filesDragHoldRef = useRef(false);
  // Bridge the effect-local scheduleFit out to the drag-release handler (same
  // pattern as sendInputRef).
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const { width: filesWidth, onHandleMouseDown: onFilesHandleDown } = useFilesPanelWidth({
    onDragStart: () => { filesDragHoldRef.current = true; },
    onDragEnd: () => {
      filesDragHoldRef.current = false;
      scheduleFitRef.current?.();
    },
  });
  // Mobile select-mode: touch has one gesture, and by default we spend it on
  // scrolling (drag → synthetic wheel). Toggling this hands the gesture back to
  // the browser so the OS long-press text selection works on the DOM-rendered
  // terminal text (→ system copy). The touch handlers read the ref (they're set
  // up once), the state drives the button + host className.
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(false);

  // ── B-121 terminal channel v2 (spec 2026-08-terminal-channel-v2 §D2) ──────
  // `lines` = the daemon streams the pane's CONTENT (tmux control mode) instead
  // of a full-screen tmux mirror, so xterm finally owns a real local
  // scrollback. Scrolling then splits into two tracks:
  //   • NORMAL buffer (95% of reading): the browser scrolls natively —
  //     pixel-perfect, with system inertia. That gesture is the entire reason
  //     this batch exists, and it only works if `touch-action` is handed back.
  //   • ALTERNATE buffer (vim, /tui fullscreen, pre-v2 claude sessions): the v1
  //     machinery stays exactly as it was — wheel hijack → `terminal-scroll`
  //     RPC, touch → synthetic wheel — because xterm's default wheel there is
  //     "send arrow keys", i.e. claude's TUI cycling through prompt history.
  // Both flags are rendered as classes (React owns the className string) and
  // `touch-action` follows them in terminal.css.
  const [linesMode, setLinesMode] = useState(false);
  const [altBuffer, setAltBuffer] = useState(false);
  // Per-mount streamMode LATCH (spec §D3 M-R2-4). A daemon switching generation
  // under a live web client is routine (vh-update / rollback — 铁律 5), and the
  // two tracks wire up different mechanisms at mount time; a hot switch would
  // leave half of them pointing at the wrong channel. Bumping this counter
  // rebuilds the terminal effect from scratch = the remount-equivalent path.
  const [streamRemount, setStreamRemount] = useState(0);
  // Paste seam, bridged out of the effect (same pattern as sendInputRef): in
  // lines mode a paste is a daemon RPC, not a local xterm bracketed paste.
  const pasteTextRef = useRef<((text: string) => Promise<void>) | null>(null);
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

  // ── Input ownership (B-093, spec 2026-08-terminal-input-ownership) ────────
  // Which input path this mount runs: xterm's helper textarea (legacy) or our
  // own controlled element. `?input=own|xterm` overrides the stored setting for
  // ONE navigation so the CDP golden key-scan can run both paths on the SAME
  // build. Resolved OUTSIDE the effect and put in its deps: flipping the switch
  // tears the terminal down and rebuilds it, which is what makes "never two
  // input paths at once" structural rather than a cleanup we have to remember.
  //
  // Step 2: the switch is now DEVICE-INDEPENDENT — coarse pointers run the same
  // own path (with the `sticky` field policy). Mutual exclusion rides entirely
  // on this one value: 'own' installs the overlay and does NOT install
  // mobileInputBridge; 'xterm' does the reverse.
  const [inputOwnershipSetting] = useLocalSettingMutable('terminalInputOwnership');
  const inputOwnership = resolveInputOwnership({
    setting: inputOwnershipSetting,
    urlParam: params.get('input'),
  });

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
        // Input-element coupling point 1/11 (spec 现状表) — via the renderer's input seam, never term.focus().
        termRef.current?.focusInput();
        break;
      case 'focus-input-bar':
        inputBarRef.current?.focus();
        break;
      case 'blur-input-bar':
        inputBarRef.current?.blur();
        break;
      case 'blur-all': {
        // Input-element coupling point 2/11 (spec 现状表) — one call instead of "blur() AND also hunt down
        // the helper textarea by class", which is exactly the shape that
        // silently misses the second input element.
        termRef.current?.blurInput();
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
    setHasTmuxSession(false);
    setShowHelp(false);
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

    // Installed further down (desktop only); declared here so the focus/diag
    // closures below can read them (they only ever run on later events).
    let imeGuard: ReturnType<typeof installImeStuckGuard> = null;
    let focusWatchdog: FocusOwnershipWatchdog | null = null;
    let ownInput: ReturnType<typeof installTermInput> = null;
    // "Is an IME composition in flight?" — used ONLY to decide whether focus
    // may be moved (moving it mid-composition silently eats the pinyin: that
    // was the direct cause of "切输入法就打不了中文"). NEVER a send gate.
    // Whoever owns the input path owns this answer.
    const composingForFocus = () =>
      ownInput?.isComposing() ?? imeGuard?.isComposingForFocus() ?? false;

    // Router basename-aware pathname (the app can be served under a subpath;
    // BASE_URL is what AppRoot feeds createBrowserRouter). NOTE: closeGuard's
    // route matchers read the raw pathname — same known gap, not touched here.
    const routePath = (): string => {
      const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
      const p = window.location.pathname;
      return base && p.startsWith(base) ? p.slice(base.length) || '/' : p;
    };
    const readFocusOwnership = (): FocusOwnershipInput => ({
      onTerminalRoute: isOpenTerminalRoute(routePath()),
      hasOverlay: hasOpenOverlay(document),
      holder: classifyFocusHolder(document.activeElement, renderer.inputElement()),
      // Focus-only composition flag (see composingForFocus): never a send gate.
      composing: composingForFocus(),
      documentHidden: document.hidden,
      windowFocused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
      coarsePointer: IS_COARSE_POINTER,
      // Dragging a selection in the sidebar also leaves activeElement on body —
      // that's "I'm about to copy", not "focus is lost"; stealing focus could
      // collapse the selection.
      hasTextSelection: hasNonCollapsedSelection(window.getSelection?.()),
    });

    // ── Diagnostics hook (see ./termDiag.ts) ────────────────────────────────
    // Half the cost of the 2026-08-14 recurrence was that NOTHING about the
    // input path could be queried in the field: the guard's counters lived in a
    // closure and focus ownership had no readable snapshot. Off in production
    // unless `debugMode` is on; onData sampling records metadata only.
    const diagEnabled =
      import.meta.env.DEV || storage.getState().localSettings.debugMode === true;
    // ── Golden key-scan surface (see ./termInputDiag.ts) ────────────────────
    // Installed on BOTH paths — the whole point is diffing `?input=xterm`
    // against `?input=own` byte-for-byte on the same build (spec §R3).
    const inputDiag = installTermInputDiag({
      enabled: diagEnabled,
      ownership: inputOwnership,
    });
    const diag = installTermDiag({
      enabled: diagEnabled,
      read: () => {
        const snap = readFocusOwnership();
        return {
          focusOwner: snap.holder,
          hasOverlay: snap.hasOverlay,
          composing: snap.composing,
          guardCounters: {
            heals: imeGuard?.counters.heals ?? 0,
            residueClears: imeGuard?.counters.residueClears ?? 0,
            focusChecks: focusWatchdog?.counters.checks ?? 0,
            focusRestores: focusWatchdog?.counters.restores ?? 0,
            focusSkippedOverlay: focusWatchdog?.counters.skippedOverlay ?? 0,
            focusSkippedComposing: focusWatchdog?.counters.skippedComposing ?? 0,
            // own 路径的合成停滞观察量（记数不动作，见termInputHost 的
            // COMPOSITION_STALE_MS）。xterm 路径下恒 0。
            compositionStaleSeen: ownInput?.counters.compositionStaleSeen ?? 0,
          },
          lastRestoreAt: focusWatchdog?.lastRestoreAt ?? 0,
        };
      },
    });

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
    // ── B-121 deep-history assembly (see ./termAssembly.ts) ─────────────────
    // lines mode opens with a SMALL snapshot (instant) plus a snapshotId naming
    // the full capture the daemon holds; this machine pulls it page by page in
    // the background and rebuilds the screen at a quiet moment. Every failure
    // path just gives up and keeps the small snapshot (功能完好，仅历史浅).
    const assembly = createTermAssembly();
    // Which channel THIS mount speaks — latched by the first successful open.
    let mountStreamMode: 'lines' | 'attach' | null = null;
    let linesActive = false;
    let quietTimer: ReturnType<typeof setInterval> | null = null;
    let remountRequested = false;
    // A fresh mount starts on the fallback track until the daemon answers;
    // stale classes from the previous mount must not survive a tid change.
    setLinesMode(false);
    setAltBuffer(false);
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
    /** Write chunks the assembly handed back (deferred or released). */
    const flushAssembly = (chunks: Uint8Array[]) => {
      for (const c of chunks) gatedWrite(c);
    };
    // Every APPLIED chunk (live or replay) funnels through here so the assembly
    // can take its atomic copy — the copy rule is INDEPENDENT of the assembly's
    // state (spec §D1: miss one chunk and the rebuilt screen forks from the
    // real one forever, because the rebuild's reset erases whatever it didn't
    // replay). It also decides write-now vs defer-behind-a-rebuild; the seq
    // bookkeeping already happened, synchronously, at the call site.
    const liveWrite = (bytes: Uint8Array) => {
      flushAssembly(assembly.noteLiveChunk(bytes));
    };

    // Apply one output chunk: seq bookkeeping SYNCHRONOUSLY (so chunks arriving
    // during an async decrypt still dedup against the right baseline), write
    // queued on outChain. 'gap' chunks are NOT written — writing across a hole
    // tears escape sequences and permanently desyncs xterm from tmux's delta
    // redraws (ghost characters backspace can never remove) — the catch-up
    // replays the hole from the daemon's ring instead.
    const applyLiveChunk = (e: { data: string; seq?: number; enc?: boolean }) => {
      const decision = sync.liveChunk(e.seq);
      if (decision === 'dup') return;
      if (decision === 'gap') {
        // The catch-up owns the screen from here (reset + snapshot, or a ring
        // replay) — a half-assembled deep history would be overwritten anyway.
        // Whatever the rebuild had deferred is still written: its seq was
        // already accepted, so no catch-up will ever replay it.
        flushAssembly(assembly.abort('gap'));
        clearQuietPoll();
        catchUp();
        return;
      }
      if (e.enc) {
        outChain = outChain.then(async () => {
          const plain = await decryptTerminalData(machineId, e.data);
          if (plain && !disposed) liveWrite(b64ToBytes(plain));
        });
      } else {
        liveWrite(b64ToBytes(e.data));
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
      // Diagnostics: metadata only (length / CJK / control), never the text.
      diag.noteOnData(d);
      // Golden key-scan buffer — records the LITERAL bytes (debugMode/dev only;
      // see termInputDiag's header for why that exception is worth its cost).
      inputDiag.noteEmitted(d);
      // Release a stuck gesture write-hold: if a lost mouseup left output
      // frozen, the user's own input (keystroke, IME commit, paste) must not
      // have its echo invisibly swallowed. No-op mid-normal-click (mouseup
      // flushes first) and for the mobile select-mode hold.
      writeHold.noteUserInput();
      // Realtime sidebar ordering, layer 1. This is the ONE chokepoint for
      // every local write into the pty — xterm onData (typing, IME commit,
      // paste), the mobile soft-keyboard bridge, the key bar, quick presets
      // and the input bar all land here — so stamping here covers them all.
      // Purely local: no daemon, no server, no round trip. Even if the remote
      // lane below is unavailable (old daemon/server, socket down), "I just
      // typed here" still floats the row instantly.
      if (terminalId) stampLocalActivity(activityKeyForTerminal(terminalId));
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

    // Same fallback, fed from the OTHER input path. Under input-ownership the
    // PRINTABLE characters never reach xterm at all (they go field → diff →
    // sendInput), so `term.onKey` above would only ever see the VT-routed keys
    // and the heuristic would silently title nothing. Enter/Backspace still go
    // through xterm's encoder (hence still through onKey), so this half only
    // accumulates printables — counting `\x7f` here too would double-decrement.
    const noteTitleFromOwnInput = (d: string) => {
      if (titled || d === '') return;
      if (startupCommandRef.current?.trim()) { titled = true; return; }
      for (const ch of d) if (ch >= ' ' && ch !== '\x7f') titleBuf += ch;
    };

    // ── Own input element (input-ownership 'own', BOTH devices since Step 2) ──
    // Installed AFTER sendInput exists (it is the pty writer) and after
    // term.open (the renderer factory already ran, so term.element and the
    // helper textarea whose geometry we copy both exist). See ./termInputHost
    // for the mechanism; the two paths are mutually exclusive by construction —
    // `inputOwnership` is an effect dep, so flipping it rebuilds the terminal,
    // and the mobileInputBridge install below is gated on the same value.
    if (inputOwnership === 'own') {
      ownInput = installTermInput({
        term,
        sendInput: (d) => { noteTitleFromOwnInput(d); sendInput(d); },
        sendKey: (ev) => renderer.sendKey(ev),
        // Through the paste chokepoint, not renderer.paste: in lines mode the
        // bytes must reach the pane via the daemon's tmux paste-buffer. (In
        // practice the host's capture-phase paste listener consumes clipboard
        // text first; this keeps the seam correct if it ever doesn't.)
        paste: (text) => {
          const viaChokepoint = pasteTextRef.current;
          if (viaChokepoint) void viaChokepoint(text);
          else renderer.paste(text);
        },
        isMac: IS_MAC,
        foreground: THEME.foreground,
        // Presentation/geometry fork only (font size vs iOS zoom, preedit
        // bubble); routing table and model are identical on both devices.
        coarsePointer: IS_COARSE_POINTER,
        // Width is a second safety signal: iPad/desktop emulation can report
        // a fine pointer while Safari still zooms focused fields below 16px.
        // This raises only the overlay typography; field policy stays tied to
        // the real pointer class.
        zoomSafeInput: NEEDS_ZOOM_SAFE_INPUT,
        // ⚠️ CONSTANT FALSE ON PURPOSE — the overlay is ALWAYS a per-key
        // surface. Line-input mode's typing surface is TermInputBar's own
        // <textarea>, which lives in .term-bottombars, OUTSIDE term.element:
        // not one of this host's listeners can see it, and its whole-line send
        // goes straight to `sendInput` below. So the "whole line gets emitted
        // incrementally AND THEN Enter appends \r" double-send can't happen —
        // the two input surfaces are disjoint DOM elements. Turning barMode on
        // here would instead make the overlay buffer silently until Enter,
        // which is the swallow-the-text failure this whole spec exists to kill.
        barMode: () => false,
        // The one documented two-device fork (spec §F): mobile must never
        // clear the field behind the OS keyboard's back.
        policy: pickFieldPolicy(IS_COARSE_POINTER),
        diag: inputDiag,
      });
      if (ownInput) renderer.setInputElement(ownInput.element);
    }

    // ── Geometry ownership (B-124) ──────────────────────────────────────────
    // v1 rendered tmux's absolute repaint, so the client's own width was
    // cosmetic. v2 ships the pane's bytes and the CLIENT wraps them, which
    // makes width part of the CONTENT: a TUI that repaints by "erase N rows"
    // (ink → Claude Code) computes N from the PANE width, so any disagreement
    // leaves the previous status line on screen — the duplicated spinner.
    // Therefore, in lines mode the screen only PROPOSES a size and adopts the
    // authoritative one where the stream says the pane actually changed (the
    // in-band OSC 6121 marker below). Resizing locally the instant the
    // container moved is precisely what produces the mismatch window.
    let geometryFallback: ReturnType<typeof setTimeout> | null = null;
    let lastReproposeAt = 0;
    const adoptGeometry = (cols: number, rows: number) => {
      if (geometryFallback) { clearTimeout(geometryFallback); geometryFallback = null; }
      if (disposed || cols < 2 || rows < 2) return;
      if (term.cols !== cols || term.rows !== rows) renderer.resizeTo(cols, rows);
      // Self-heal: we now render what the stream assumes, but this viewport
      // wants its own size (an old terminal carries whatever geometry the
      // device that used it last left behind). Ask for ours — one proposal per
      // adoption, and only from the window the user is actually looking at, so
      // two open devices settle on the focused one instead of ping-ponging.
      const want = renderer.proposeFit();
      if (!want || !terminalId) return;
      if (want.cols === cols && want.rows === rows) return;
      const focused = typeof document === 'undefined'
        || (document.visibilityState === 'visible' && document.hasFocus());
      if (!focused || Date.now() - lastReproposeAt < 3000) return;
      lastReproposeAt = Date.now();
      apiSocket.send('terminal-resize', { machineId, terminalId, cols: want.cols, rows: want.rows });
    };
    // Safety belt: if the daemon never confirms (wedged tmux, a size tmux
    // silently refused, a proposal that matched the pane so no %layout-change
    // was emitted), fall back to the locally measured size rather than leave
    // the screen stuck at a stale width.
    const GEOMETRY_CONFIRM_MS = 1500;
    const doFit = () => {
      if (linesActive) {
        const want = renderer.proposeFit();
        if (!want || !terminalId) return;
        apiSocket.send('terminal-resize', { machineId, terminalId, cols: want.cols, rows: want.rows });
        if (geometryFallback) clearTimeout(geometryFallback);
        geometryFallback = setTimeout(() => {
          geometryFallback = null;
          if (!disposed) renderer.resizeTo(want.cols, want.rows);
        }, GEOMETRY_CONFIRM_MS);
        return;
      }
      safeFit();
      if (terminalId) apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
    };

    // The daemon's in-band geometry marker: ESC ] 6121 ; cols ; rows BEL,
    // injected into the output stream at the exact point tmux resized the pane
    // (it rides the normal seq/ring/replay path, so a catch-up replays it too).
    // A private OSC is inert everywhere that does not know it — an old web and
    // the daemon's own headless simply drop it.
    const geometryOsc = renderer.raw?.parser.registerOscHandler(6121, (payload: string) => {
      const [c, r] = payload.split(';').map((n) => Number(n));
      if (Number.isFinite(c) && Number.isFinite(r)) adoptGeometry(c, r);
      return true;
    });
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
      // Files-handle drag in flight: hold refits (see filesDragHoldRef above);
      // the drag-end callback runs one scheduleFit after release.
      if (filesDragHoldRef.current) return;
      if (kbStabilizer.pending()) return;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        doFit();
      });
    };
    scheduleFitRef.current = scheduleFit;
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(mount);
    window.addEventListener('resize', scheduleFit);
    // Give the terminal keyboard focus back. Three rules, all of them paid for
    // (2026-08-14, CDP-measured):
    //  1. IDEMPOTENT — already focused ⇒ do nothing. A focus() on the element
    //     that already has focus is harmless, but the check keeps every caller
    //     of this function free of "did I just disturb an active field?".
    //  2. NEVER blur(). The previous version did `ta.blur(); term.focus()` to
    //     also clear a stuck IME composition, and THAT was the direct cause of
    //     "切输入法就打不了中文": blurring mid-composition delivers
    //     compositionend to xterm, which emits ZERO onData — the pinyin the
    //     user had already typed is silently discarded. English never noticed,
    //     which is why this looked like a CJK-only bug for two rounds.
    //     Clearing a genuinely stuck composition is imeStuckGuard's job (its
    //     non-229 heal branch, measured to work) plus its blur-scoped residue
    //     clear; focus is not a treatment.
    //  3. SKIP WHILE COMPOSING — same reason as (2), for any other trigger.
    //     The flag comes from imeStuckGuard's browser-event-fed tracker, not
    //     from xterm's private `_isComposing`.
    // Fine pointers only, so mobile never force-opens the soft keyboard.
    const refocusTerminal = () => {
      if (IS_COARSE_POINTER || disposed || document.hidden) return;
      // Input-element coupling point 3/11 (spec 现状表) — asks the renderer seam instead of hunting the
      // helper textarea by class, so it is right on both input paths.
      if (renderer.isInputFocused()) return; // rule 1
      if (composingForFocus()) return; // rule 3
      renderer.focusInput(); // rule 2: focus only, never blur
    };
    // rAF is paused while the tab is hidden, so a resize that lands in the
    // background never gets fitted; re-fit when the tab becomes visible again.
    // Becoming visible again (tab switch, or mobile screen unlock) → re-fit and
    // catch up any output missed while hidden. catchUp is defined below in the
    // same effect scope; onVisible only runs on events, long after the effect
    // body (and catchUp) has initialized. Focus is NOT restored from here any
    // more: visibilitychange, window 'focus' and stray focus moves all feed the
    // ownership watchdog (installed below), which only acts when focus is
    // genuinely unowned — the old unconditional refocus on these events could
    // steal focus from a dialog input and fired mid-composition.
    const onVisible = () => { if (!document.hidden) { scheduleFit(); catchUp(); } };
    document.addEventListener('visibilitychange', onVisible);
    // bfcache restore (iOS Safari commonly restores from bfcache on unlock and
    // fires pageshow rather than visibilitychange) → same catch-up path.
    const onPageShow = () => { if (!document.hidden) { scheduleFit(); catchUp(); } };
    window.addEventListener('pageshow', onPageShow);
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
      const decodeMaybeEnc = async (dataB64: string): Promise<Uint8Array | null> => {
        if (!res.encStream) return b64ToBytes(dataB64);
        const plain = await decryptTerminalData(machineId, dataB64);
        return plain ? b64ToBytes(plain) : null;
      };
      if (res.mode === 'snapshot') {
        sync.snapshotApplied(res.seq, seqAtCall);
        // The copy rule starts at the ASSIGN, not when the restore closure
        // finally runs: chunks racing the restore are applied against the new
        // baseline and therefore belong in the rebuild's replay.
        startAssembly(res);
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
          const bytes = await decodeMaybeEnc(res.data);
          // `alternateOn` (lines mode): the capture is the pane's ALT screen,
          // so it needs a synthesized \x1b[?1049h in front — otherwise the alt
          // content lands in the normal buffer, poisoning the very scrollback
          // this batch exists to build AND putting the scroll track on the
          // wrong rail until the deep rebuild lands (spec §D1 R3 M-R3-3).
          if (bytes && !disposed) {
            gatedWrite(prefixAlternateEnter(bytes, res.alternateOn === true));
          }
          writeHold.endSnapshotRestore();
        };
      }
      // Replay: apply only chunks newer than what we already have (decided
      // NOW, against the current baseline); then the daemon's reported seq
      // covers anything the replay didn't include.
      const fresh = res.chunks.filter((c) => sync.replayChunk(c.seq));
      sync.replayDone(res.seq);
      return async () => {
        // Through liveWrite, not gatedWrite: replayed chunks are APPLIED
        // post-baseline content, so an assembly in flight must copy them too.
        for (const c of fresh) {
          const bytes = await decodeMaybeEnc(c.data);
          if (bytes && !disposed) liveWrite(bytes);
        }
      };
    };

    // ── Deep-history assembly driver (spec §D1「传输与重建」) ────────────────
    // Page fetch discipline: 2 requests in flight (more would head-of-line
    // block the live output stream sharing this socket), 15s per attempt, one
    // retry, then the whole assembly is abandoned. `snapshot-expired` (the
    // daemon replaced or dropped the held capture) abandons it too and retries
    // the open exactly once.
    const HISTORY_PAGE_TIMEOUT_MS = 15_000;
    const HISTORY_PAGE_CONCURRENCY = 2;
    const HISTORY_PAGE_ATTEMPTS = 2; // = one retry
    const QUIET_POLL_MS = 400;
    let openRetriedAfterExpiry = false;

    const withPageTimeout = (p: Promise<TerminalHistoryPage>): Promise<TerminalHistoryPage> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (v: TerminalHistoryPage) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(
          () => finish({ ok: false, expired: false, error: 'history page timeout' }),
          HISTORY_PAGE_TIMEOUT_MS,
        );
        p.then(finish, () => finish({ ok: false, expired: false, error: 'history page failed' }));
      });

    const fetchHistoryPage = async (
      snapshotId: string,
      page: number,
      encPages: boolean,
    ): Promise<Uint8Array | 'expired' | 'failed'> => {
      for (let attempt = 0; attempt < HISTORY_PAGE_ATTEMPTS; attempt++) {
        const r = await withPageTimeout(
          machineTerminalHistory(machineId, terminalId, snapshotId, page),
        );
        if (disposed) return 'failed';
        if (r.ok) {
          // History pages follow the SAME encStream rule as the snapshot they
          // belong to. A payload we can't decrypt is not something to write
          // onto the screen — give up and keep the small snapshot.
          if (!encPages) return b64ToBytes(r.data);
          const plain = await decryptTerminalData(machineId, r.data);
          return plain ? b64ToBytes(plain) : 'failed';
        }
        if (r.expired) return 'expired'; // retrying can't resurrect the capture
      }
      return 'failed';
    };

    const fetchHistoryPages = async (
      gen: number,
      snapshotId: string,
      totalPages: number,
      encPages: boolean,
    ) => {
      let next = 0;
      let stopped = false;
      const worker = async () => {
        while (!stopped) {
          const page = next++;
          if (page >= totalPages) return;
          const r = await fetchHistoryPage(snapshotId, page, encPages);
          // A newer open/catch-up superseded this run — its pages are stale.
          if (disposed || gen !== assembly.generation) { stopped = true; return; }
          if (r === 'expired') {
            stopped = true;
            flushAssembly(assembly.abort('snapshot-expired'));
            clearQuietPoll();
            // Retry the whole open ONCE: forceSnapshot makes the daemon take a
            // new capture and hand back a fresh snapshotId.
            if (!openRetriedAfterExpiry) {
              openRetriedAfterExpiry = true;
              catchUp({ forceSnapshot: true });
            }
            return;
          }
          if (r === 'failed') {
            stopped = true;
            flushAssembly(assembly.abort('page-failed'));
            clearQuietPoll();
            return;
          }
          if (assembly.pageArrived(gen, page, r) === 'stale') { stopped = true; return; }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(HISTORY_PAGE_CONCURRENCY, totalPages) }, worker),
      );
    };

    /** Start (or restart) the background history pull for a lines snapshot. */
    const startAssembly = (
      res: Extract<Awaited<ReturnType<typeof machineOpenTerminal>>, { success: true }>,
    ) => {
      // A lines-mode REPLAY carries no snapshotId (spec §D1 M-R4-5) — nothing
      // to assemble; anything in flight keeps running against its own capture.
      if (res.streamMode !== 'lines' || !res.snapshotId) return;
      // Supersede: flush what the old run had deferred BEFORE dropping it (the
      // upcoming reset will erase it, but a silently dropped write is exactly
      // the shape that turns into a content hole when the reset doesn't come).
      flushAssembly(assembly.abort('superseded'));
      if (!assembly.start({ snapshotId: res.snapshotId, totalPages: res.totalPages ?? 0 })) return;
      const gen = assembly.generation;
      armQuietPoll();
      void fetchHistoryPages(gen, res.snapshotId, res.totalPages ?? 0, res.encStream === true);
    };

    // ── The quiet gate (spec §D1 R3 M-R3-1 + M-R3-4, merged) ────────────────
    // A rebuild resets the screen, so it may only run when the user is neither
    // SELECTING (a reset destroys the selection — and beginSnapshotRestore's
    // "drop the hold" semantics exist for reconnects, not for background
    // beautification) nor READING scrolled-back history (a reset yanks the
    // viewport to the bottom). Polled rather than event-driven: both conditions
    // are owned elsewhere, and "wait one more beat" is always a safe answer —
    // the small snapshot stays usable the entire time.
    const atBottom = () => {
      const buf = term.buffer.active;
      return buf.viewportY >= buf.baseY;
    };
    const clearQuietPoll = () => {
      if (quietTimer == null) return;
      clearInterval(quietTimer);
      quietTimer = null;
    };
    let rebuildScheduled = false;
    const armQuietPoll = () => {
      if (quietTimer != null) return;
      quietTimer = setInterval(() => {
        if (disposed || assembly.state === 'done' || assembly.state === 'idle') {
          clearQuietPoll();
          return;
        }
        if (assembly.state !== 'awaiting-quiet' || rebuildScheduled) return;
        // Cheap pre-check, so a user who is reading scrolled-back history
        // doesn't get work queued on the write chain every 400ms.
        if (writeHold.isHolding() || !atBottom()) return;
        rebuildScheduled = true;
        outChain = outChain.then(() => runRebuild());
      }, QUIET_POLL_MS);
    };

    // The atomic rebuild, in ONE outChain slot so nothing interleaves:
    // reset → history pages → the live chunks applied since the baseline.
    // These are the ONLY writes in the client allowed to bypass seq judgement
    // (they are daemon history and replays of already-applied content). Live
    // chunks arriving while this is queued still go through liveChunk — lastSeq
    // keeps advancing and gaps keep being detected — only their WRITE waits,
    // and it is flushed in arrival order the instant the rebuild is written.
    // (Routing them raw instead would freeze lastSeq → the next normal chunk
    // reads as a gap → catch-up resets → the deep history just built is wiped.)
    const runRebuild = () => {
      rebuildScheduled = false;
      if (disposed) { assembly.abort('disposed'); return; }
      // The gate is re-evaluated HERE, inside the slot that does the writing:
      // the user can start a selection or scroll up in the gap between the poll
      // tick and this slot reaching the front of the queue, and a rebuild is
      // precisely what must not happen then. A failed re-check just leaves the
      // assembly in awaiting-quiet for the next tick.
      const plan: AssemblyRebuildPlan | null =
        assembly.tryRebuild(!writeHold.isHolding() && atBottom());
      if (!plan) return;
      clearQuietPoll();
      term.reset();
      for (const b of plan.pages) term.write(b);
      for (const b of plan.copies) term.write(b);
      flushAssembly(assembly.finishRebuild());
      term.scrollToBottom();
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
      clearQuietPoll();
      assembly.abort('disposed');
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
            // Same capability declaration as the mount-time open — the daemon
            // needs it on EVERY open to know which response shape to build.
            streamMode: 'lines',
          });
          if (disposed) return;
          if (!res.success) {
            if (res.gone) onGone();
            return;
          }
          // streamMode latch (spec §D3 M-R2-4): the daemon changed generation
          // under us (vh-update / rollback). The two tracks wire up different
          // mechanisms at mount time, so rebuild the mount instead of hot-
          // switching — and do NOT apply this response, the new mount opens
          // from scratch.
          const mode = res.streamMode ?? 'attach';
          if (mountStreamMode != null && mode !== mountStreamMode && !remountRequested) {
            remountRequested = true;
            clearQuietPoll();
            assembly.abort('disposed');
            setStreamRemount((n) => n + 1);
            return;
          }
          if (remountRequested) return;
          enc = res.encStream === true;
          tmuxAttached = !!res.tmuxSession;
          setHasTmuxSession(tmuxAttached);
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
    // B-121 SCOPE NOTE: everything in this block is the ALTERNATE-buffer track
    // and stays exactly as it was — in lines mode the normal buffer simply
    // never enters it (the guard below already returns early there, because
    // xterm's local scrollback is real), while vim / `/tui fullscreen` / any
    // pre-v2 claude session still needs it. The `terminal-scroll` RPC, the
    // 60ms wheel batching, the failure backoff and the touch→synthetic-wheel
    // bridge are therefore NOT retired (spec §D4 M-R2-1).
    //
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

    // Which scroll track is live is a function of the ACTIVE BUFFER, so the
    // screen has to follow xterm in and out of the alternate screen: normal =
    // native scrolling (touch-action handed back to the browser), alternate =
    // the synthetic-wheel track (touch-action: none, or our preventDefault is
    // silently ignored and the gesture scrolls the page instead). Only the CSS
    // class is driven from here — the JS handlers read term.buffer directly.
    const bufferDisp = term.buffer.onBufferChange(() => {
      if (disposed) return;
      setAltBuffer(term.buffer.active.type === 'alternate');
    });

    // Blank-screen belt (defense in depth behind the seq fixes): if the mount's
    // restore left the screen with NO text at all while the daemon reports a
    // live tmux session, something upstream returned an empty snapshot (e.g. a
    // just-recreated session whose tmux attach repaint got lost) — force one
    // full re-snapshot. tmux always paints a status line, so an attached
    // session is never legitimately all-blank for long.
    //
    // RETIRED on the lines track (spec §D2, R2 裁决): the belt's premise is
    // "tmux always paints something", which only holds for the full-screen
    // mirror. A content stream from a fresh shell legitimately shows nothing
    // until the prompt prints, so the timer would fire false re-snapshots on
    // exactly the quiet terminals it can least afford to disturb. "Terminal
    // exists but is empty" is the open response's job to state, not a timer's
    // to guess. The attach fallback keeps it verbatim.
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
        // A resume request (B-149) wins over the configured startup command:
        // the user asked for THIS conversation, not for the usual boot script.
        startupCommand: (isFresh && createResumeCmdRef.current) || startupCommandRef.current,
        // Starting directory for the create path only (see createCwdRef).
        cwd: isFresh ? createCwdRef.current : undefined,
        // Only the fresh-create navigation may create the tmux session; any
        // other mount (sidebar nav, URL refresh) attaches to what exists —
        // a deleted terminal's stale URL must not resurrect it (>= 0.2.29;
        // older daemons keep create-or-attach).
        attachOnly: !isFresh,
        // B-121 capability declaration. An old daemon ignores it and answers
        // with the v1 shape (no `streamMode`), which is exactly the attach
        // fallback below — so it is safe to send unconditionally (铁律 4).
        streamMode: 'lines',
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
      setHasTmuxSession(tmuxAttached);
      // Latch the channel for this mount (see mountStreamMode / streamRemount).
      // Absent streamMode = old daemon = the v1 attach path, fully preserved.
      mountStreamMode = res.streamMode ?? 'attach';
      linesActive = mountStreamMode === 'lines';
      setLinesMode(linesActive);
      // Adopt the pane's authoritative geometry BEFORE the restore is written:
      // the capture was taken at that width, and (more importantly) everything
      // the application streams next assumes it (B-124).
      if (linesActive && res.paneCols && res.paneRows) adoptGeometry(res.paneCols, res.paneRows);
      setAltBuffer(term.buffer.active.type === 'alternate');
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
      // Input-element coupling point 4/11 (spec 现状表).
      if (!(IS_COARSE_POINTER && focusStateRef.current.barMode)) renderer.focusInput();
      // Arm the blank-screen belt once the restore (and stash flush) has been
      // written; give late tmux-attach repaint chunks a moment to land first.
      outChain = outChain.then(() => {
        if (disposed || !res.tmuxSession) return;
        if (linesActive) return; // belt retired on the lines track (see above)
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

    // ── Paste chokepoint (spec §D1b「粘贴专路」) ─────────────────────────────
    // Attach mode: xterm's local bracketed paste, unchanged.
    // Lines mode: the daemon has NO pty — it writes to the pane with send-keys,
    // where a multi-line literal EXECUTES line by line, and it cannot re-derive
    // the pane's bracketed-paste state (tmux 3.6b exposes no such format). So a
    // paste becomes its own RPC: the daemon does load-buffer + `paste-buffer -p`
    // on the SAME control-mode command FIFO the keystrokes ride, which is also
    // what keeps "paste, then Enter" in order — two executors let the Enter land
    // first and run an empty line. Awaitable for exactly that reason (the run
    // preset sends \r after this resolves).
    //
    // Text goes out with LF separators; tmux's paste-buffer translates them to
    // CR. Local-side bookkeeping that normally rides sendInput (activity stamp,
    // stuck-hold release) is done here, since these bytes bypass it.
    const pasteText = async (text: string): Promise<void> => {
      if (!text || disposed) return;
      if (!linesActive || !terminalId) {
        term.paste(text);
        return;
      }
      writeHold.noteUserInput();
      stampLocalActivity(activityKeyForTerminal(terminalId));
      await machineTerminalPaste(machineId, terminalId, text.replace(/\r\n?/g, '\n'));
    };
    pasteTextRef.current = pasteText;

    // Upload files to the machine (→ ~/.happy/uploads/terminal/) and paste the
    // absolute paths at the cursor. Shared by drag-drop and clipboard paste.
    // Bracketed paste (local or via the daemon), so nothing auto-executes. Paths
    // are single-quoted; the daemon sanitizes names to [\w.-] so no quoting edge.
    const uploadFilesToTerminal = async (files: File[]) => {
      for (const source of files) {
        const displayName = source.name || 'file';
        const f = new File([source], terminalUploadName(displayName), { type: source.type });
        setFileUpload({ name: displayName, sent: 0, total: f.size });
        const r = await uploadTerminalFile(machineId, f, {
          onProgress: (sent, total) => {
            if (!disposed) setFileUpload({ name: displayName, sent, total });
          },
        });
        if (r.success && r.path && !disposed) {
          const fallbackQuoteStyle = machine?.metadata?.platform === 'win32' ? 'unknown' : 'posix';
          const quotedPath = quoteTerminalUploadPath(r.path, r.pathQuoteStyle ?? fallbackQuoteStyle);
          if (quotedPath) {
            await pasteText(`${quotedPath} `);
            toast.success(t('terminal.uploadComplete', { name: displayName }));
          } else {
            toast.error(t('terminal.uploadPathNotInserted', { name: displayName, path: r.path }));
          }
        } else if (!disposed) {
          toast.error(t('terminal.uploadFailed', { name: displayName, error: r.error || t('common.error') }));
        }
      }
      if (!disposed) setFileUpload(null);
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
      if (files.length === 0) {
        // Attach mode: text paste → xterm's own bracketed-paste path, as before.
        if (!linesActive) return;
        // Lines mode: clipboard TEXT must go through the daemon too, or a
        // multi-line paste is re-encoded as send-keys and executes line by line
        // (spec §D1b M4). Consumed HERE, on the host's capture listener, so it
        // covers both input paths at once — xterm's helper textarea and the
        // own-input overlay both live inside this host element.
        const text = e.clipboardData?.getData('text') ?? '';
        if (!text) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void pasteText(text);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      void uploadFilesToTerminal(files);
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
      const p = e.changedTouches[0];
      if (!p) return;
      const dx = p.clientX - touchX;
      const dy = p.clientY - touchY;
      const distanceSquared = dx * dx + dy * dy;
      // A tap is the ONE explicit gesture that may summon the keyboard — route
      // it through the focus policy (it also clears a prior dismissal). The
      // resulting term.focus() still runs synchronously inside this touchend
      // (iOS only opens the keyboard inside the user-gesture call stack). In
      // input-bar mode the same tap instead blurs the bar (tap output = "let
      // me read", normal web semantics).
      // Chrome synthesizes compatibility mouse events after a touch tap. On
      // the own-input path xterm consumes those and focuses its hidden textarea
      // after we focus ours, creating an own -> xterm -> own bounce that closes
      // the mobile keyboard on the first tap. Claim only the real tap; drags,
      // select mode, and the xterm-owned path remain native.
      completeTerminalTouchTap({
        inputOwnership,
        selectMode: selectModeRef.current,
        distanceSquared,
        threshold: 12,
        cancelable: e.cancelable,
      }, {
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
        dispatchTap: () => dispatchFocus({ type: 'tap' }),
      });
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
      // B-121 lines mode, NORMAL buffer = the native track: hands completely
      // off. xterm owns a real local scrollback here, so the browser scrolls it
      // with pixel-level tracking and system inertia — the entire point of this
      // batch. No preventDefault, no synthetic wheel, no RPC. (`touch-action`
      // is handed back in CSS via .term-host--lines; without both halves the
      // gesture either doesn't scroll or isn't cancelable.) The ALTERNATE
      // buffer falls through to the v1 synthetic-wheel track below.
      if (linesActive && term.buffer.active.type !== 'alternate') return;
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
        // Input-element coupling point 5/11 (spec 现状表) — "focus is still on the terminal" must be true
        // for EITHER input element, not just xterm's helper textarea.
        const target =
          isTerminalInputElement(ae) ? 'terminal'
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
      // Non-passive is load-bearing for the own-input tap: preventDefault()
      // suppresses Chrome's compatibility mouse events and their second focus.
      host.addEventListener('touchend', onTouchEnd, TERMINAL_TOUCH_END_OPTIONS);
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
      //
      // NOT on the own path (Step 2): there our overlay owns the keyboard and
      // xterm's helper textarea never gets focus, so this bridge would have
      // nothing to observe — but its capture-phase keydown/input listeners on
      // term.element would still be live, and a second diff engine mirroring a
      // second field is exactly the "one keypress written to the pty twice"
      // shape (spec §R4). One switch, two mutually exclusive installs.
      if (inputOwnership !== 'own') mobileBridge = installMobileInputBridge(term, sendInput);
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
      // Plain click on the terminal = explicit intent to type here. Idempotent
      // and composition-safe (see refocusTerminal); it no longer blurs, so a
      // click can't eat an in-flight composition either.
      refocusTerminal();
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
      //
      // NOT installed on the 'own' path: there the stuck state it detects is
      // UNREACHABLE (xterm's CompositionHelper never receives a composition
      // event because its textarea never gets focus), and a guard that pokes
      // xterm's helper flags while our element owns the field is pure risk —
      // round 2's lesson was that the treatment itself became the disease.
      if (inputOwnership !== 'own') imeGuard = installImeStuckGuard(term);
      // ── Focus-ownership watchdog (./termFocusOwnership.ts) ────────────────
      // The persistent half of the 2026-08-14 failure was NOT an IME bug: after
      // ⌘K palette → Esc / ⌘R rename → Esc, `document.activeElement === BODY`
      // and typing went nowhere (0 bytes to the pty, both languages), while
      // xterm's cursor merely turned hollow — invisible to the user. Handing
      // focus back was an accidental behavior written in three places and
      // MISSING in every non-⌘W dialog. Instead of patching each dialog, the
      // invariant is enforced centrally: terminal route + no overlay + focus
      // owned by nobody ⇒ the terminal gets it back. Never blurs, never steals
      // from a real owner, never acts mid-composition.
      focusWatchdog = installFocusOwnershipWatchdog({
        read: readFocusOwnership,
        restore: refocusTerminal,
      });
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
      if (geometryFallback) { clearTimeout(geometryFallback); geometryFallback = null; }
      try { geometryOsc?.dispose(); } catch { /* already disposed */ }
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
      clearQuietPoll();
      // No flush on the way out — the screen is going away, and writing to a
      // disposed terminal is what we'd get for the trouble.
      assembly.abort('disposed');
      bufferDisp.dispose();
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
        focusWatchdog?.dispose();
        focusWatchdog = null;
      }
      ownInput?.dispose();
      ownInput = null;
      renderer.setInputElement(null);
      diag.dispose();
      inputDiag.dispose();
      writeHoldRef.current = null;
      sendInputRef.current = null;
      scheduleFitRef.current = null;
      pasteTextRef.current = null;
      dataDisp.dispose();
      keyDisp.dispose();
      if (terminalId) apiSocket.send('terminal-close', { machineId, terminalId });
      term.dispose();
      termRef.current = null;
    };
    // `streamRemount` is a dep on purpose: a daemon that swaps channel under a
    // live mount (vh-update / rollback) is handled by REBUILDING this effect,
    // never by hot-switching tracks inside it (spec §D3 M-R2-4).
  }, [machineId, tid, inputOwnership, streamRemount]);

  // Returns when the text has actually reached the pane — load-bearing for
  // execPreset: in lines mode the paste is an RPC while the trailing \r rides
  // the terminal-input channel, and firing them concurrently is exactly the
  // "Enter lands first and runs an empty line" reordering the spec calls out.
  const runCommand = (command: string): Promise<void> => {
    const tm = termRef.current;
    if (!tm) return Promise.resolve();
    // Paste seam (B-121): lines mode routes through the daemon's tmux
    // paste-buffer RPC, attach mode keeps xterm's local bracketed paste.
    // Either way the user presses Enter to run — never auto-execute.
    const viaChokepoint = pasteTextRef.current;
    const done = viaChokepoint ? viaChokepoint(command) : (tm.paste(command), Promise.resolve());
    // Mobile: route through the focus policy (explicit menu gesture → may
    // focus + clear a dismissal; in input-bar mode it leaves focus with the
    // bar). Desktop keeps the unconditional historical refocus.
    // Input-element coupling point 6/11 (spec 现状表).
    if (IS_COARSE_POINTER) dispatchFocus({ type: 'snippet' });
    else tm.focusInput();
    return done;
  };

  // Shortcut (insert kind) → terminal input. Bracketed paste — never
  // auto-executes; the user presses Enter to send — with the text normalized
  // (see ./termPresetPaste) so a trailing newline can never double as an
  // auto-submit on paste paths without bracketed paste.
  const insertPreset = (text: string) => {
    const paste = presetPasteText(text);
    if (paste) void runCommand(paste);
  };

  // Insert target for the notes dock (vh:insert-to-input) — same insert-only
  // semantics as presets (normalized, bracketed paste, never auto-executes).
  const insertPresetRef = useRef(insertPreset);
  insertPresetRef.current = insertPreset;
  useEffect(() => onInsertToInput((text) => insertPresetRef.current(text)), []);

  // Shortcut (run kind, run:true) → paste THEN execute. The paste lands via
  // xterm's synchronous onData → sendInput, so the trailing \r is sequenced
  // after the command text on the pty: inside a bracketed-paste TUI it
  // submits the pasted input; in a plain shell it runs the line. This is the
  // ONE path that auto-executes — the same entry picked from the chat
  // composer only inserts.
  const execPreset = (text: string) => {
    const paste = presetPasteText(text);
    if (!paste) return;
    // AWAITED (B-121): in attach mode runCommand resolves synchronously and
    // this is the historical behavior verbatim; in lines mode the paste is an
    // RPC and the \r must not race it onto the pane.
    void runCommand(paste).then(() => sendInputRef.current?.('\r'));
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
        <BackButton />
        <button className="term-title" onClick={onRename} title={t('common.rename')}>
          <span className="term-title-text">{title}</span>
          <Pencil size={13} className="term-title-edit" />
        </button>
        <div className="term-header-right">
          {connecting && <span className="term-connecting mono">{t('common.loading')}</span>}
          {/* B-105: structured-view toggle — header-level on purpose (mobile
              must reach it in one glance, never inside a menu). Only exists
              while the daemon reports a mirror session for this terminal. */}
          {mirrorSessionId && (
            <button
              className="sb-icon-btn"
              title={t('terminal.structuredView')}
              aria-label={t('terminal.structuredView')}
              onClick={goStructured}
            >
              <MessagesSquare size={18} />
            </button>
          )}
          {/* B-115: quick notes entry (prompt stash lives one tap away). */}
          <button
            type="button"
            className="sb-icon-btn"
            title={t('notes.title')}
            aria-label={t('notes.title')}
            onClick={toggleNotesPanel}
          >
            <StickyNote size={18} />
          </button>
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
              // Input-element coupling point 7/11 (spec 现状表).
              onCancel={() => termRef.current?.focusInput()}
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
          {hasTmuxSession && <button
            className="sb-icon-btn"
            title={t('tmuxHelp.title')}
            onClick={() => setShowHelp(true)}
          >
            <HelpCircle size={18} />
          </button>}
        </div>
      </header>
      {/* term-mid: desktop (fine pointer, wide) = flex ROW so the file browser
          splits the width with the terminal (B-088); coarse/narrow viewports
          set it to display:contents (CSS) so the terminal stays a direct flex
          child of .term-screen — the mobile keyboard-avoidance maxHeight math
          on .term-host depends on that column geometry. */}
      <div className="term-mid">
        {/* term-host--lines / --alt drive `touch-action` (see terminal.css):
            the lines track hands the touch gesture back to the browser for
            native scrollback scrolling, except on the alternate screen where
            the v1 synthetic-wheel track still needs to own it. */}
        <div
          ref={hostRef}
          className={
            `term-host${selectMode ? ' is-selecting' : ''}`
            + `${linesMode ? ' term-host--lines' : ''}`
            + `${altBuffer ? ' term-host--alt' : ''}`
          }
        >
          {selectMode && <div className="term-select-hint mono">{t('terminal.selectModeHint')}</div>}
          {fileUpload && (
            <div className="term-upload-status mono" role="status" aria-live="polite">
              <span>{t('terminal.uploadingFile')} {fileUpload.name}</span>
              <span>{fileUpload.total > 0 ? Math.round((fileUpload.sent / fileUpload.total) * 100) : 100}%</span>
              <i
                style={{
                  '--term-upload-progress': `${fileUpload.total > 0 ? (fileUpload.sent / fileUpload.total) * 100 : 100}%`,
                } as CSSProperties}
              />
            </div>
          )}
          <div ref={innerRef} className="term-host-inner" />
        </div>
        {filesOpen && machineId && (
          <>
            {/* Scrim only materializes on narrow viewports (CSS) — desktop keeps
                the terminal interactive next to the browser, like sd-files. */}
            <div className="term-files-scrim" onClick={() => setFilesOpen(false)} aria-hidden />
            {filesSplit && (
              <div
                className="app-resize-handle term-files-handle"
                onMouseDown={onFilesHandleDown}
                role="separator"
                aria-orientation="vertical"
              />
            )}
            <aside className="term-files" style={filesSplit ? { width: filesWidth } : undefined}>
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
            <TermPresetsMenu
              variant="keybar"
              onPick={insertPreset}
              onRun={execPreset}
              // Same post-close refocus as the header variant. The in-gesture
              // dispatchFocus inside runCommand is what opens the iOS keyboard;
              // this pass is what makes the focus STICK past the menu's
              // FocusScope, so typing/Enter lands in the terminal.
              onCancel={() => dispatchFocus({ type: 'snippet' })}
            />
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
      {showHelp && hasTmuxSession && <TmuxHelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
