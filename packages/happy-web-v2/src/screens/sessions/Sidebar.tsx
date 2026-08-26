import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { isAppChord } from '@/app/appChord';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Plus, Settings, TerminalSquare, MoreHorizontal, MessageSquare, MessagesSquare, PanelLeftClose, LayoutGrid, SlidersHorizontal, ArrowUp, ArrowDown, ChevronRight, Pencil, Archive, X, AudioLines, ArrowDownWideNarrow, ListOrdered, Tags, Flag, StickyNote, ListChecks, FolderOpen, FolderTree, FileDiff, Rows3, RotateCcw } from 'lucide-react';
import { useSessions, useSetting, useLocalSetting, useLocalSettingMutable, useAllMachines, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createTerminalOrPick, createTerminalAt } from '@/app/newTerminal';
import { createChatOrConfigure } from '@/app/newChat';
import { getSessionName, getSessionSidebarSubtitle, formatLastSeen } from '@/utils/sessionUtils';
import { machineLabel, isMachineOnline } from '@/utils/machineUtils';
import { buildClosedTerminalRows } from '@/sync/closedTerminals';
import { confirmArchiveSession, nextSessionPathAfterClose, confirmCloseTerminal, saveRowRename, collectAllTags } from '@/app/rowActions';
import { sessionUpdateTitleTags } from '@/sync/ops';
import { hasPriorityTag, togglePriorityTag, sortPriorityFirst } from '@/utils/tags';
import { visibleSidebarSessions } from './sidebarRows';
import { groupRowsByTag } from './sidebarTagGroups';
import { groupRowsByWorkspace, resolveSidebarGroupMode, type SidebarGroupMode, type SidebarWorkspaceGroup } from './sidebarWorkspaceGroups';
import type { Session } from '@/sync/storageTypes';
// aliased: `Settings` is already taken by the lucide gear icon above
import type { Settings as SyncedSettings } from '@/sync/settings';
import { StatusDot, CyberMark, QuickThemeToggle, TagChip, TagOverflowChip, ActionDropdownMenu, ActionContextMenu, type MenuItemDef } from '@/ui';
import { useSocketStatus, socketToStatus } from '@/app/useConnection';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { useIsDesktop } from '@/app/useMediaQuery';
import { useTranslation } from '@/i18n/useTranslation';
import { isImeGuardedEvent } from '@/utils/ime';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useActivityOverlay } from '@/sync/activityOverlayStore';
import { resolveActivityTs } from '@/sync/activityOverlay';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { useBoardAttentionCount, useBoardItems } from '@/screens/board/useBoardItems';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { openCommandPalette } from '@/screens/command/CommandPalette';
import { NewSessionModal } from './NewSessionModal';
import { NewTerminalModal } from './NewTerminalModal';
import { RenameModal } from './RenameModal';
import { splitPinnedRows } from './sidebarPins';
import { sortRowsByManualOrder, mergeLegacyPinned, planSidebarOrder, pruneEntries } from './sidebarOrder';
import {
  resolveSidebarSort,
  sortRowsByRecent,
  shouldHoldReorder,
  applyReorderHold,
  SIDEBAR_RECENT_SORT_ENABLED,
} from './sidebarRecentSort';
import { groupRowsByLifecycle, completedTodaySessions } from './sidebarStatusView';
import { attentionKeysOf, rowSignalOf, type RowSignal } from './sidebarAttention';
import { rowRenameMenuTranslationKeys } from './sidebarRowMenu';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { resolveTerminalOpenPath } from '@/sync/terminalViewPref';
import './sidebar.css';

function rowHref(r: Row): string {
  return r.href;
}

/** 列表 (manual order) / 状态 (lifecycle groups) / 归档 — see the filter row. */
type View = 'list' | 'status' | 'archived';

interface Row {
  key: string;
  kind: 'terminal' | 'session';
  /** Resolved before click so a mirrored terminal never paints xterm first. */
  href: string;
  /** last-active time — the recent sort's key (both the 列表 view's recent
   *  mode and the 状态 view's in-group order). Definition per row kind lives
   *  in sidebarRecentSort.ts's header; in short: chat = updatedAt||activeAt||
   *  createdAt, terminal = tmux last activity (createdAt on old daemons). */
  ts: number;
  /** creation time — orders the unkeyed "new rows" zone (newest first) */
  createdAt: number;
  session?: Session;
  terminalId?: string;
  machineId?: string;
  machineName?: string;
  workspacePath?: string;
  /** Present only for structured sessions; powers a real Changes target. */
  sessionId?: string;
  title: string;
  subtitle: string;
  tags?: string[];
  /** B-150: terminal rows the daemon brought back after a restart. Cleared by
   *  the daemon on first open, so the badge disappears by itself. */
  restored?: boolean;
}

interface SidebarSection {
  id: string;
  label: string | undefined;
  count: number;
  rows: Row[];
  collapsible: boolean;
  open: boolean;
  detail?: string;
  changesSessionId?: string | null;
}

function sessionRow(s: Session): Row {
  return {
    key: s.id,
    kind: 'session',
    href: `/session/${encodeURIComponent(s.id)}`,
    ts: s.updatedAt || s.activeAt || s.createdAt,
    createdAt: s.createdAt,
    session: s,
    sessionId: s.id,
    machineId: s.metadata?.machineId,
    machineName: s.metadata?.host,
    workspacePath: s.metadata?.path,
    title: getSessionName(s),
    subtitle: getSessionSidebarSubtitle(s),
    tags: s.metadata?.tags,
  };
}

export function Sidebar() {
  const navigate = useNavigate();
  const sessions = useSessions();
  const socket = useSocketStatus();
  const { t } = useTranslation();
  // Three segments, ONE state: 列表/状态 are display modes over the active
  // set, 归档 is a filter over a different set — but three parallel segments
  // is the simplest surface. Only the display modes persist
  // (localSettings.sidebarView, an enum that can't even hold 'archived');
  // the archive view intentionally resets to the remembered mode on reload
  // so nobody gets stranded there.
  const [savedView, setSavedView] = useLocalSettingMutable('sidebarView');
  const [view, setView] = useState<View>(savedView);
  const selectView = useCallback(
    (v: View) => {
      setView(v);
      if (v !== 'archived') setSavedView(v);
    },
    [setSavedView],
  );
  const [showNew, setShowNew] = useState(false);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [cmdHeld, setCmdHeld] = useState(false);
  const terminals = useTerminalSessions((s) => s.terminals);
  const terminalViewDefault = useLocalSetting('terminalViewDefault');
  const terminalViewOverrides = useLocalSetting('terminalViewOverrides');
  const toggleCollapsed = useSidebarPrefs((s) => s.toggleCollapsed);
  const isDesktop = useIsDesktop();

  // Terminal list/agent-state ingestion lives in the AppLayout-level singleton
  // (sync/terminalSync.ts: daemon pushes) so it also runs with the sidebar
  // collapsed or on mobile detail screens. This component is a pure consumer
  // of its stores.

  const attentionCount = useBoardAttentionCount();

  // ----- sort mode (列表 view) -----
  // Synced `sidebarSort`: 'recent' (default) auto-sorts every row by last
  // activity, newest on top, terminals and chats MIXED — a terminal is a
  // session too, so nothing is pinned above by kind. 'manual' hands the list
  // back to the `sidebarOrder` table below. The two fields are independent on
  // purpose: 'recent' never clears `sidebarOrder`, so the switch is LOSSLESS —
  // flipping back to 'manual' restores the hand-made arrangement exactly.
  const sortMode = resolveSidebarSort(useSetting('sidebarSort'));
  /** 列表 is the only orderable view: 状态's order is the lifecycle verdict,
   *  归档 stays a plain activity list. */
  const orderable = view === 'list';
  // ----- grouping lens (B-208, 列表 view only) -----
  // One menu owns flat/workspace/tag. The legacy B-091 boolean gets precedence
  // when true so devices that opted into tag grouping keep that choice.
  // While grouped, drag/move reordering is disabled: the sequence is derived
  // from a grouping key, so a positional drop has nothing meaningful to write.
  const [groupByTag, setGroupByTag] = useLocalSettingMutable('sidebarGroupByTag');
  const [savedGroupMode, setSavedGroupMode] = useLocalSettingMutable('sidebarGroupMode');
  const groupMode = resolveSidebarGroupMode(savedGroupMode, groupByTag);
  const grouped = orderable && groupMode !== 'none';
  const selectGroupMode = useCallback((mode: SidebarGroupMode) => {
    setSavedGroupMode(mode);
    // Mirror tag into B-091's old flag so a Web rollback keeps the user's tag
    // choice instead of silently presenting a flat list.
    setGroupByTag(mode === 'tag');
  }, [setGroupByTag, setSavedGroupMode]);
  /** Surfaces whose order can shift WITHOUT the user acting — the ones the
   *  hover hold below has to protect. (Manual mode reorders only on a drag,
   *  which must apply instantly.) */
  const autoSorted = (orderable && sortMode === 'recent') || view === 'status';

  // ----- realtime activity overlay -----
  // The row `ts` values built below come from the DURABLE lanes, which are
  // both correct and slow: a chat's `updatedAt` needs a server round trip, and
  // a terminal's pushed `activityAt` only moves when daemonState is rewritten
  // (≤ once a minute for output alone — see ACTIVITY_SIGNATURE_BUCKET_MS in
  // the CLI). These two maps carry the fast truth on top of them:
  //   local  — my own actions in THIS browser (typed into a terminal, opened
  //            and focused one, sent a chat message). No network at all.
  //   remote — the daemon's ephemeral `terminal-activity` frames (~1s), which
  //            is what makes pure OUTPUT float without a daemonState write.
  // Applied with max(), so an overlay can only float a row, never sink one,
  // and every row degrades to its durable value when the overlays are empty
  // (old daemon, old server, fresh profile, socket down).
  const localActivity = useActivityOverlay((s) => s.local);
  const remoteActivity = useActivityOverlay((s) => s.remote);

  // ----- 已结束终端 (B-084, archived view only) -----
  // New daemons push recent close records in daemonState.closedTerminals
  // (≤20/machine); old daemons never write the field → empty → the section
  // doesn't render. Pure merge/sort/live-filter in sync/closedTerminals.ts.
  const allMachines = useAllMachines({ includeOffline: true });
  const closedRows = useMemo(
    () =>
      view === 'archived'
        ? buildClosedTerminalRows(
            allMachines.map((m) => ({
              id: m.id,
              name: machineLabel(m),
              online: isMachineOnline(m),
              daemonState: m.daemonState,
            })),
            new Set(terminals.map((tm) => tm.id)),
          )
        : [],
    [view, allMachines, terminals],
  );

  const rows = useMemo<Row[] | null>(() => {
    if (!sessions) return null;
    // visibleSidebarSessions also excludes the assistant meta-session (B-091
    // leak fix: this inline filter used to miss it — regression-tested in
    // sidebarRows.test.ts). Applies to the archived view too.
    const sessRows = visibleSidebarSessions(sessions, view).map(sessionRow);
    // terminals are always "live"; hidden only by the archived-only view
    const termRows: Row[] =
      view === 'archived'
        ? []
        : terminals.map((tm) => ({
            key: `t:${tm.id}`,
            kind: 'terminal',
            href: resolveTerminalOpenPath({
              machineId: tm.machineId,
              terminalId: tm.id,
              mirrorSessionId: tm.mirrorSessionId,
              defaultView: terminalViewDefault,
              overrides: terminalViewOverrides,
            }),
            // tmux last activity (daemon push: MachineTerminal.activityAt,
            // already mapped onto updatedAt by terminalPushOps with a
            // createdAt fallback for daemons too old to send it).
            ts: tm.updatedAt ?? tm.createdAt,
            createdAt: tm.createdAt,
            terminalId: tm.id,
            machineId: tm.machineId,
            machineName: tm.machineName,
            workspacePath: tm.cwd,
            title: tm.title || tm.machineName,
            tags: tm.tags,
            subtitle: `${tm.machineName} · terminal`,
            restored: !!tm.restoredAt,
          }));
    // One place applies the overlay for every ACTIVITY-ORDERED surface, so
    // 列表/状态/归档 can't disagree about what "last active" means. (已完成(今日)
    // below builds its rows separately and deliberately doesn't get the
    // overlay — its order comes from when the ✓ was pressed, not from `ts`.)
    return [...termRows, ...sessRows].map((r) => {
      const ts = resolveActivityTs(r.ts, r.key, localActivity, remoteActivity);
      return ts === r.ts ? r : { ...r, ts };
    });
  }, [sessions, terminals, view, localActivity, remoteActivity, terminalViewDefault, terminalViewOverrides]);

  // ----- reorder hold (mis-click guard) -----
  // An auto-sorted list must never yank a row out from under the pointer: the
  // row you were about to click would be replaced by another one mid-press.
  // So while the pointer is inside the list the RENDERED order is frozen to
  // the sequence that was on screen when it entered; the pending order is
  // applied the moment the pointer leaves, or after REORDER_HOLD_MS with the
  // pointer motionless (a parked cursor must not freeze the sidebar forever).
  // Row content, status dots and the selected-row highlight all keep updating
  // — only the SEQUENCE is held (see applyReorderHold for how appearing /
  // disappearing rows are handled). The decision is a pure function so it can
  // be unit-tested; this hook is only the plumbing.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [heldKeys, setHeldKeys] = useState<string[] | null>(null);
  const heldRef = useRef<string[] | null>(null);
  /** Row keys as currently RENDERED — the snapshot taken when the hold arms. */
  const displayedKeysRef = useRef<string[]>([]);
  const pointerRef = useRef({ inside: false, lastAt: 0 });
  useEffect(() => {
    const release = () => {
      if (heldRef.current === null) return;
      heldRef.current = null;
      setHeldKeys(null);
    };
    const el = listRef.current;
    if (!el || !autoSorted) {
      release();
      return;
    }
    const arm = () => {
      pointerRef.current.inside = true;
      pointerRef.current.lastAt = Date.now();
      if (heldRef.current !== null) return; // already frozen — just refresh the clock
      const snapshot = displayedKeysRef.current.slice();
      heldRef.current = snapshot;
      setHeldKeys(snapshot);
    };
    const leave = () => {
      pointerRef.current.inside = false;
      release();
    };
    el.addEventListener('pointerenter', arm);
    el.addEventListener('pointermove', arm);
    el.addEventListener('pointerleave', leave);
    // The idle release needs its own clock: a motionless pointer emits no
    // events, so nothing else would ever fire to end the hold.
    const iv = setInterval(() => {
      if (heldRef.current === null) return;
      const p = pointerRef.current;
      if (!shouldHoldReorder({ pointerInside: p.inside, lastPointerAt: p.lastAt || null, now: Date.now() })) {
        release();
      }
    }, 250);
    return () => {
      el.removeEventListener('pointerenter', arm);
      el.removeEventListener('pointermove', arm);
      el.removeEventListener('pointerleave', leave);
      clearInterval(iv);
      release();
    };
  }, [autoSorted]);

  // ----- status mode (lifecycle groups) -----
  // The board's derivation IS the sidebar's classification: useBoardItems
  // carries lifecycle (boardItems.lifecycleOf) and groupRowsByLifecycle only
  // maps row keys onto that verdict — there is no second classifier, so
  // sidebar and board can never disagree about running vs. waiting. The order
  // WITHIN each group is the sidebar's own: most recently active first, the
  // same model as the 列表 view's recent sort.
  const boardItems = useBoardItems();

  // ----- two-level row signal (B-085) -----
  // 待处理 (accent) = the board's urgent waiting band — permission request /
  // terminal needs_input / LLM review/blocked. Same classifier as the board
  // (no re-derivation), so sidebar accent rows == board urgent items == the
  // conversations notifications deep-link into. 未读 (text-stage) = agent
  // finished a turn while the user wasn't looking (memory-only set, cleared
  // on open). rowSignalOf ranks them; the decision table is unit-tested in
  // sidebarAttention.test.ts.
  const attentionKeys = useMemo(() => attentionKeysOf(boardItems), [boardItems]);
  const unreadIds = storage((s) => s.unreadSessionIds);

  const statusGroups = useMemo(() => {
    if (view !== 'status' || !rows) return null;
    const g = groupRowsByLifecycle(rows, boardItems);
    // One flat held sequence, applied per group (applyReorderHold tolerates a
    // superset of keys) — group membership itself still follows the board.
    return {
      waiting: applyReorderHold(heldKeys, g.waiting),
      running: applyReorderHold(heldKeys, g.running),
    };
  }, [view, rows, boardItems, heldKeys]);
  // 已完成(今日): sessions completed via the board's ✓ in the last 24h (same
  // window and source as the board's Done column). Collapsed by default so
  // the live groups keep the space. Date.now() in the memo is fine — session
  // changes are what re-derive it; the window edge doesn't need a live clock.
  const [completedOpen, setCompletedOpen] = useState(false);
  const completedRows = useMemo<Row[]>(() => {
    if (view !== 'status' || !sessions) return [];
    const list = sessions.filter((s): s is Session => typeof s !== 'string');
    return completedTodaySessions(list, Date.now()).map(sessionRow);
  }, [view, sessions]);

  // ----- manual order -----
  // Synced settings field `sidebarOrder` — FULL manual ordering: every row
  // key maps to a fractional order key; unkeyed rows (new sessions/terminals)
  // render on top, newest first. While it's still empty the legacy
  // `pinnedRows` display applies (pinned section on top, activity order
  // below — section header removed); the FIRST drag materializes the whole
  // visible sequence into keys, folding the legacy pins in at their top
  // positions (mergeLegacyPinned). Ordering only shapes the ACTIVE list; the
  // archived view stays a plain activity list.
  //
  // This table is only CONSULTED in `sidebarSort === 'manual'` — under the
  // default 'recent' it stays on disk, untouched, so the mode switch is
  // lossless in both directions. It is still pruned (below) either way, so a
  // long stay in recent mode can't let it rot into ghosts.
  const orderSetting = useSetting('sidebarOrder');
  const pinnedSetting = useSetting('pinnedRows'); // legacy, pre-materialization only
  const orderedRows = useMemo<Row[] | null>(() => {
    if (!rows) return null;
    if (view === 'status') {
      if (!statusGroups) return null;
      // The flat visible sequence — must mirror the rendered section order
      // exactly (⌘1-9 badges and move-up/down read positions from it).
      // Collapsed 已完成 rows are NOT visible, so they don't take numbers.
      return [
        ...statusGroups.waiting,
        ...statusGroups.running,
        ...(completedOpen ? completedRows : []),
      ];
    }
    if (!orderable) return rows; // 归档: plain activity list, unchanged
    // 列表: whatever base order applies, `priority`-tagged rows float on top
    // as a stable partition (B-091) — an explicit user marker outranks both
    // the activity sort and the manual arrangement. (状态 gets the same
    // effect via the board's comparator; 归档 stays plain history.)
    const priorityFirst = (list: Row[]) => sortPriorityFirst(list, (r) => hasPriorityTag(r.tags));
    // recent mode: one mixed sequence by last activity, hold applied.
    if (sortMode === 'recent') return applyReorderHold(heldKeys, priorityFirst(sortRowsByRecent(rows)));
    if ((orderSetting ?? []).length > 0) return priorityFirst(sortRowsByManualOrder(rows, orderSetting!));
    const { pinned, rest } = splitPinnedRows(rows, pinnedSetting ?? []);
    return priorityFirst([...pinned, ...rest]);
  }, [rows, view, statusGroups, completedRows, completedOpen, orderSetting, pinnedSetting, orderable, sortMode, heldKeys]);
  // Tag grouping (列表 view): group the ordered sequence by first tag; the
  // FLAT displayRows below stays the exact rendered order (⌘1-9 badges and
  // the quick-switch read it), so it must be the groups flattened.
  const tagGroups = useMemo(
    () => (orderable && groupMode === 'tag' && orderedRows ? groupRowsByTag(orderedRows) : null),
    [orderable, groupMode, orderedRows],
  );
  const workspaceGroups = useMemo(
    () => (orderable && groupMode === 'workspace' && orderedRows ? groupRowsByWorkspace(orderedRows) : null),
    [orderable, groupMode, orderedRows],
  );
  const displayRows = useMemo<Row[] | null>(
    () => workspaceGroups
      ? workspaceGroups.flatMap((g) => g.rows)
      : tagGroups
        ? tagGroups.flatMap((g) => g.rows)
        : orderedRows,
    [workspaceGroups, tagGroups, orderedRows],
  );
  // Feeds the hold's arming snapshot (assigned during render, read by the
  // pointer listeners) — always the sequence actually on screen.
  displayedKeysRef.current = displayRows?.map((r) => r.key) ?? [];

  // Commit a reorder: `seqKeys` = the final VISIBLE sequence, `movedKey` =
  // the row the user moved. Reads settings from the store (not the render
  // closure) — a drag can outlive a re-render. First commit materializes
  // everything (legacy pins folded in); afterwards the plan is minimal
  // (usually a single entry). Invisible keyed entries are carried untouched.
  //
  // Dragging in RECENT mode also flips `sidebarSort` to 'manual': the gesture
  // IS the expression of manual intent, and asking the user to find a toggle
  // first (or silently discarding their drag) would both be worse. The switch
  // is seamless because `seqKeys` is the recent order they were looking at,
  // so the list only changes by the one row they moved.
  const commitSeq = useCallback((seqKeys: string[], movedKey: string) => {
    const st = storage.getState().settings;
    const cur = st.sidebarOrder ?? [];
    const next =
      cur.length === 0
        ? planSidebarOrder([], mergeLegacyPinned(seqKeys, (st.pinnedRows ?? []).map((p) => p.key)), movedKey)
        : planSidebarOrder(cur, seqKeys, movedKey);
    const delta: Partial<SyncedSettings> = {};
    if (next !== cur) delta.sidebarOrder = next;
    if (resolveSidebarSort(st.sidebarSort) !== 'manual') delta.sidebarSort = 'manual';
    if (Object.keys(delta).length > 0) sync.applySettings(delta);
  }, []);

  // Menu fallback (the only reorder path on coarse pointers): swap with the
  // adjacent row in the full visible list. `index` is where the row was
  // RENDERED when the menu opened — in recent mode the list can have
  // re-sorted since (opening the menu moves the pointer out of the list and
  // releases the hold), so the key is the truth and the index only a hint.
  const moveRow = useCallback((key: string, index: number, dir: -1 | 1) => {
    const list = rowsRef.current;
    if (!list) return;
    const from = list[index]?.key === key ? index : list.findIndex((r) => r.key === key);
    if (from < 0) return;
    const j = from + dir;
    if (j < 0 || j >= list.length) return;
    const keys = list.map((r) => r.key);
    [keys[from], keys[j]] = [keys[j], keys[from]];
    commitSeq(keys, key);
  }, [commitSeq]);

  // Drag ANY row to ANY position (fine pointers only; coarse pointers use the
  // row menu's move up/down instead). Pointer-event hand-rolled — same school
  // as SidebarResizeHandle, no dnd dependency. While dragging, an accent
  // insertion line tracks the drop slot; the list stays put (insertion-line
  // model, no live reorder) and the settings write happens once, on drop.
  // (`listRef` is declared up with the reorder hold, which also needs it.)
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropLineY, setDropLineY] = useState<number | null>(null);

  const onRowPointerDown = (e: React.PointerEvent, key: string) => {
    if (e.button !== 0) return;
    // Only the list view is orderable: status order is the lifecycle verdict,
    // archived is a plain activity list. Dragging works in BOTH sort modes —
    // in recent mode the drop switches the mode (see commitSeq). Grouped-by-
    // tag disables dragging: the sequence is derived from tags (B-091).
    if (!orderable || grouped) return;
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) return;
    if ((e.target as HTMLElement).closest('.sb-row-menu')) return;
    const list = listRef.current;
    if (!list) return;
    const startY = e.clientY;
    const state = { active: false, lastY: startY, raf: 0, drop: null as number | null };

    // Recompute the drop index + insertion line from a pointer Y. Rows are
    // measured from the live DOM ([data-dragkey], DOM order = display order);
    // the dragged row itself doesn't count, so `drop` is the insertion index
    // over the OTHER rows.
    const update = (clientY: number) => {
      const els = Array.from(list.querySelectorAll<HTMLElement>('[data-dragkey]'));
      const others = els.filter((el) => el.dataset.dragkey !== key);
      let idx = 0;
      for (const el of others) {
        const r = el.getBoundingClientRect();
        if (clientY > r.top + r.height / 2) idx++;
        else break; // DOM order — midpoints are monotone
      }
      state.drop = idx;
      const listRect = list.getBoundingClientRect();
      const yOf = (el: HTMLElement, edge: 'top' | 'bottom') =>
        (edge === 'top' ? el.getBoundingClientRect().top : el.getBoundingClientRect().bottom) -
        listRect.top +
        list.scrollTop;
      if (others.length === 0) setDropLineY(0);
      else if (idx < others.length) setDropLineY(yOf(others[idx], 'top'));
      else setDropLineY(yOf(others[others.length - 1], 'bottom'));
    };

    // Edge auto-scroll: without it a row can't be dragged to the top of a
    // list longer than the viewport. rAF loop while the drag is live.
    const EDGE = 28;
    const STEP = 7;
    const autoScroll = () => {
      if (!state.active) return;
      const rect = list.getBoundingClientRect();
      let d = 0;
      if (state.lastY < rect.top + EDGE) d = -STEP;
      else if (state.lastY > rect.bottom - EDGE) d = STEP;
      if (d !== 0) {
        const before = list.scrollTop;
        list.scrollTop = before + d;
        if (list.scrollTop !== before) update(state.lastY);
      }
      state.raf = requestAnimationFrame(autoScroll);
    };

    const onMove = (ev: PointerEvent) => {
      if (!state.active) {
        if (Math.abs(ev.clientY - startY) < 6) return;
        state.active = true;
        setDragKey(key);
        state.raf = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      state.lastY = ev.clientY;
      update(ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(state.raf);
      const drop = state.drop;
      setDragKey(null);
      setDropLineY(null);
      if (!state.active || drop === null) return;
      // The release lands on a row button — swallow the click it would
      // produce so a drag never doubles as "open this conversation".
      const swallow = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true } as any), 150);
      // Final visible sequence = the other rows (live DOM order) with the
      // dragged row inserted at the drop index. commitSeq materializes /
      // plans the order keys and writes settings once.
      const keys = Array.from(list.querySelectorAll<HTMLElement>('[data-dragkey]'))
        .map((el) => el.dataset.dragkey!)
        .filter((k) => k !== key);
      const idx = Math.max(0, Math.min(keys.length, drop));
      keys.splice(idx, 0, key);
      commitSeq(keys, key);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // Prune order entries whose target is gone (deleted session, archived
  // session, dead terminal). Rendering already skips them (unmatched keys
  // never produce rows); this is the periodic write-back so the synced list
  // doesn't accumulate ghosts. A key is only pruned after being missing in
  // TWO consecutive sweeps — guards against transient emptiness while
  // machine/terminal state is still loading (a too-eager prune would sync
  // the loss to every device). The terminal list derives from the machines
  // slice (daemon pushes), so isDataReady is the same load gate for both key
  // kinds. Pre-materialization the same sweep prunes the legacy pinnedRows
  // (still the live model then); post-materialization that field is frozen.
  const missingKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sweep = () => {
      const st = storage.getState();
      if (!st.isDataReady) return;
      const order = st.settings.sidebarOrder ?? [];
      const legacyPinned = st.settings.pinnedRows ?? [];
      const target: Array<{ key: string }> = order.length > 0 ? order : legacyPinned;
      if (target.length === 0) return;
      const valid = new Set<string>();
      for (const s of Object.values(st.sessions)) {
        if (s.active) valid.add(s.id);
      }
      for (const tm of useTerminalSessions.getState().terminals) valid.add(`t:${tm.id}`);
      const missingNow = new Set<string>();
      for (const e of target) {
        if (!valid.has(e.key)) missingNow.add(e.key);
      }
      const confirmed = new Set([...missingNow].filter((k) => missingKeysRef.current.has(k)));
      missingKeysRef.current = missingNow;
      if (confirmed.size === 0) return;
      const keep = new Set(target.map((e) => e.key).filter((k) => !confirmed.has(k)));
      if (order.length > 0) {
        const next = pruneEntries(order, keep);
        if (next) sync.applySettings({ sidebarOrder: next });
      } else {
        const next = pruneEntries(legacyPinned, keep);
        if (next) sync.applySettings({ pinnedRows: next });
      }
    };
    const iv = setInterval(sweep, 60_000);
    return () => clearInterval(iv);
  }, []);

  // ----- rename modal (title + tags) -----
  const [renameTarget, setRenameTarget] = useState<Row | null>(null);
  // Suggestions: every tag currently in use across sessions and terminals.
  const allTags = useMemo(() => collectAllTags(sessions, terminals), [sessions, terminals]);

  // Quick-switch: hold ⌘/Ctrl to reveal 1-9 badges on the first rows; ⌘/Ctrl+digit
  // jumps to that conversation. Mirrors the v1 power-user shortcut. Order =
  // exactly what's on screen (displayRows) — manual order included.
  const rowsRef = useRef<Row[] | null>(displayRows);
  rowsRef.current = displayRows;
  useEffect(() => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      setCmdHeld(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // IME guard: keys routed through a CJK composition must never trigger
      // shortcuts — this runs in the CAPTURE phase over every input. The
      // guarded variant also covers the just-committed-composition window
      // (fed by ime.ts's global compositionend listener).
      if (isImeGuardedEvent(e)) return;
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const list = rowsRef.current;
        const target = list?.[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          setCmdHeld(false);
          navigate(rowHref(target));
        }
        return;
      }
      // ⌘/Ctrl+N and ⌥N → new terminal: NOT handled here anymore. The listener
      // moved to the AppLayout-level useNewTerminalShortcuts() hook so it also
      // works with the sidebar collapsed/unmounted (mobile detail, /board).
      // ⌘/Ctrl+R → rename the currently open conversation/terminal. Unlike
      // ⌘N/⌘1-9, ⌘R IS interceptable via preventDefault (it's page reload, not
      // a browser-window command), so this works in a normal tab too. This
      // listener is registered in the CAPTURE phase (below) precisely so it runs
      // BEFORE xterm's textarea keydown handler on the terminal page — otherwise
      // xterm consumes the event and the browser reloads before we ever see it.
      // We only preventDefault when the current route maps to a row — on any
      // other screen the native reload is left intact. window.location (not a
      // captured value) so it's never stale against this once-registered handler.
      // isAppChord：macOS 上 Ctrl+R 是终端 readline 的 reverse-search-history。
      if (isAppChord(e) && !e.altKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        const cur = `${window.location.pathname}${window.location.search}`;
        const target = rowsRef.current?.find((r) => rowHref(r) === cur);
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          // Opens the rename modal (title + tags) instead of the old
          // single-line prompt — same dialog as the row menu's Rename.
          setRenameTarget(target);
        }
        return;
      }
      // long-press ⌘/Ctrl (no other key) → reveal badges after a short delay
      if ((e.key === 'Meta' || e.key === 'Control') && !holdTimer) {
        holdTimer = setTimeout(() => setCmdHeld(true), 280);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') clear();
    };
    // CAPTURE phase: run before xterm (or any focused input) can swallow the
    // shortcut. Especially matters for ⌘R on the terminal page.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      if (holdTimer) clearTimeout(holdTimer);
    };
  }, [navigate]);

  // Render model: list/archived = one unlabeled section; status = the three
  // lifecycle sections. `rows` holds only the VISIBLE rows (collapsed 已完成
  // → []), `count` the section's real size for the header.
  const sections = useMemo<SidebarSection[]>(() => {
    if (view === 'status' && statusGroups) {
      return [
        {
          id: 'waiting',
          label: t('sidebar.groupWaiting') as string | undefined,
          count: statusGroups.waiting.length,
          rows: statusGroups.waiting,
          collapsible: false,
          open: true,
        },
        {
          id: 'running',
          label: t('sidebar.groupRunning') as string | undefined,
          count: statusGroups.running.length,
          rows: statusGroups.running,
          collapsible: false,
          open: true,
        },
        {
          id: 'completed',
          label: t('sidebar.groupDoneToday') as string | undefined,
          count: completedRows.length,
          rows: completedOpen ? completedRows : [],
          collapsible: true,
          open: completedOpen,
        },
      ];
    }
    // 列表 + 按 tag 分组: one section per tag group, same sb-section-head
    // chrome as the status view. Untagged rows tail as 未分组.
    if (tagGroups) {
      return tagGroups.map((g) => ({
        id: g.tag === null ? 'untagged' : `tag:${g.tag.toLowerCase()}`,
        label: (g.tag ?? (t('sidebar.groupUntagged') as string)) as string | undefined,
        count: g.rows.length,
        rows: g.rows,
        collapsible: false,
        open: true,
      }));
    }
    if (workspaceGroups) {
      return workspaceGroups.map((g: SidebarWorkspaceGroup<Row>) => ({
        id: `workspace:${g.key}`,
        label: (g.name ?? (t('sidebar.workspaceUnassigned') as string)) as string | undefined,
        detail: [g.machineName, g.path].filter(Boolean).join(' · '),
        count: g.rows.length,
        rows: g.rows,
        collapsible: false,
        open: true,
        changesSessionId: g.representativeSessionId,
      }));
    }
    return [
      {
        id: 'all',
        label: undefined as string | undefined,
        count: displayRows?.length ?? 0,
        rows: displayRows ?? [],
        collapsible: false,
        open: true,
      },
    ];
  }, [view, statusGroups, completedRows, completedOpen, tagGroups, workspaceGroups, displayRows, t]);

  return (
    <div className="sb">
      <header className="sb-header">
        {/* Mark only — the "very happy" wordmark was dropped to keep the
            header from overflowing as header-right icons accumulated. */}
        <button className="sb-brand sb-brand--button" type="button" onClick={() => navigate('/help')} title={t('sidebar.openHelp')} aria-label={t('sidebar.openHelp')}>
          <CyberMark size={22} />
        </button>
        <div className="sb-header-right">
          <StatusDot status={socketToStatus(socket)} pulse={socket === 'connecting'} title={socket} />
          {/* Coarse pointers can't press ⌘K — this icon opens the command
              palette (which replaced the sidebar search box; #tag included).
              CSS shows it on coarse pointers only: desktop learned ⌘K from
              the palette itself. */}
          <button className="sb-icon-btn sb-search-btn" title={t('sidebar.openSearch')} onClick={openCommandPalette}>
            <Search size={17} />
          </button>
          {/* Sort-mode switch — 列表 view only (状态 orders by lifecycle, 归档
              is a plain activity list, so the toggle would be a lie there).
              Visible on every pointer class: it's one existing-size icon in a
              row that already flexes, so it costs no extra space on mobile.
              Flipping to 'manual' does NOT rebuild sidebarOrder — the old
              arrangement is still there and comes straight back. */}
          {orderable && SIDEBAR_RECENT_SORT_ENABLED && (
            <button
              className="sb-icon-btn"
              title={t(sortMode === 'recent' ? 'sidebar.sortByRecent' : 'sidebar.sortManual')}
              aria-label={t(sortMode === 'recent' ? 'sidebar.sortByRecent' : 'sidebar.sortManual')}
              onClick={() =>
                sync.applySettings({ sidebarSort: sortMode === 'recent' ? 'manual' : 'recent' })
              }
            >
              {sortMode === 'recent' ? <ArrowDownWideNarrow size={17} /> : <ListOrdered size={17} />}
            </button>
          )}
          {/* B-208: one grouping menu instead of another permanent header icon.
              Workspace is the default lens; tag and flat remain one tap away. */}
          {orderable && (
            <ActionDropdownMenu
              align="end"
              sideOffset={6}
              items={[
                { key: 'workspace', label: `${groupMode === 'workspace' ? '✓ ' : ''}${t('sidebar.groupWorkspace')}`, icon: FolderTree, onSelect: () => selectGroupMode('workspace') },
                { key: 'tag', label: `${groupMode === 'tag' ? '✓ ' : ''}${t('sidebar.groupTags')}`, icon: Tags, onSelect: () => selectGroupMode('tag') },
                { key: 'none', label: `${groupMode === 'none' ? '✓ ' : ''}${t('sidebar.groupNone')}`, icon: Rows3, onSelect: () => selectGroupMode('none') },
              ]}
            >
              <button className={`sb-icon-btn${groupMode !== 'none' ? ' is-on' : ''}`} title={t('sidebar.groupMenu')} aria-label={t('sidebar.groupMenu')}>
                {groupMode === 'workspace' ? <FolderTree size={17} /> : groupMode === 'tag' ? <Tags size={17} /> : <Rows3 size={17} />}
              </button>
            </ActionDropdownMenu>
          )}
          {/* form switch: the Siri-like voice assistant (B-051). The assistant
              screen carries the mirror button in the same top-left slot. */}
          <button
            className="sb-icon-btn"
            title={t('assistant.title')}
            onClick={() => navigate('/assistant')}
          >
            <AudioLines size={17} />
          </button>
          <button
            className="sb-icon-btn sb-board-btn"
            title={t('board.title')}
            onClick={() => navigate('/board')}
          >
            <LayoutGrid size={17} />
            {attentionCount > 0 && (
              <span className="sb-board-badge mono">{attentionCount > 9 ? '9+' : attentionCount}</span>
            )}
          </button>
          {/* Collapse only exists in the two-pane desktop layout. On mobile
              (single pane) AppLayout ignores `collapsed` entirely, so this
              button did nothing visible — worse, it silently wrote
              collapsed=1 to localStorage and the NEXT desktop visit opened
              with the sidebar unexpectedly collapsed. Same 980px breakpoint
              as the layout itself, so button and behavior can't disagree. */}
          {isDesktop && (
            <button className="sb-icon-btn" title={t('sidebar.collapse')} onClick={toggleCollapsed}>
              <PanelLeftClose size={17} />
            </button>
          )}
          {/* Quick create: spawns directly with the remembered machine/
              directory and the settings defaults; falls back to the full
              dialog only when it can't decide (or always-ask is on). */}
          <ActionDropdownMenu
            align="end"
            sideOffset={6}
            items={[
              {
                key: 'chat',
                label: t('newSessionModal.chatTitle'),
                icon: MessageSquare,
                onSelect: () => void createChatOrConfigure(navigate, () => setShowNew(true)),
              },
              {
                key: 'advanced',
                label: t('newSessionModal.advancedTitle'),
                icon: SlidersHorizontal,
                onSelect: () => setShowNew(true),
              },
              {
                key: 'terminal',
                label: t('newSessionModal.terminalTitle'),
                icon: TerminalSquare,
                onSelect: () => createTerminalOrPick(navigate),
              },
              {
                // B-144: same terminal, but pick the working directory first —
                // the startup command then runs in the project, not in $HOME.
                // ⌘N / ⌥N deliberately stay on the one-click path above.
                key: 'terminal-at',
                label: t('newSessionModal.terminalAtTitle'),
                icon: FolderOpen,
                onSelect: () => setShowNewTerminal(true),
              },
            ]}
          >
            <button className="sb-icon-btn" title={t('sidebar.newSession')}>
              <Plus size={18} />
            </button>
          </ActionDropdownMenu>
        </div>
      </header>

      {/* The search box is gone — ⌘K (mobile: the header icon) covers search,
          #tag grammar included. Its row folded into the view switch below, so
          the net chrome above the list SHRANK by one row. */}
      <div className="sb-filter" role="tablist">
        {(['list', 'status', 'archived'] as View[]).map((v) => (
          <button
            key={v}
            className={`sb-filter-btn${view === v ? ' is-on' : ''}`}
            onClick={() => selectView(v)}
          >
            {t(
              v === 'list'
                ? 'sidebar.viewList'
                : v === 'status'
                  ? 'sidebar.viewStatus'
                  : 'sidebar.filterArchived',
            )}
          </button>
        ))}
        {/* Board lives on the header icon (badge included) — a fourth tab in
            this row read as clutter and was removed. */}
      </div>

      <div className={`sb-list${dragKey ? ' is-dragging' : ''}`} ref={listRef}>
        {displayRows === null ? (
          <div className="sb-loading">
            <StatusDot status="thinking" pulse /> {t('common.loading')}
          </div>
        ) : sections.every((sec) => sec.count === 0) && closedRows.length === 0 ? (
          <div className="sb-empty">{t('sidebar.empty')}</div>
        ) : (
          <>
            {(() => {
              // Flat row index ACROSS sections — must mirror displayRows
              // exactly (⌘1-9 badges + move-up/down read rowsRef positions).
              let flat = 0;
              return sections.map((sec) => (
                <div key={sec.id} className="sb-section">
                  {sec.label !== undefined &&
                    (sec.collapsible ? (
                      // Only 已完成 is collapsible; it's the only section with
                      // this header variant, so the toggle can be direct.
                      <button
                        className="sb-section-head sb-section-head--toggle"
                        onClick={() => setCompletedOpen((o) => !o)}
                        aria-expanded={sec.open}
                      >
                        <ChevronRight
                          size={11}
                          className={`sb-section-chevron${sec.open ? ' is-open' : ''}`}
                        />
                        <span className="sb-section-label">{sec.label}</span>
                        <span className="sb-section-count mono">{sec.count}</span>
                      </button>
                    ) : (
                      <div className={`sb-section-head${sec.changesSessionId ? ' sb-section-head--workspace' : ''}`} title={sec.detail || undefined}>
                        <span className="sb-section-label">{sec.label}</span>
                        <span className="sb-section-count mono">{sec.count}</span>
                        {sec.detail && <span className="sb-section-detail">{sec.detail}</span>}
                        {sec.changesSessionId && (
                          <button
                            type="button"
                            className="sb-workspace-changes"
                            title={t('sidebar.openWorkspaceChanges')}
                            aria-label={`${t('sidebar.openWorkspaceChanges')}: ${sec.label}`}
                            onClick={() => navigate(`/session/${encodeURIComponent(sec.changesSessionId!)}?panel=changes`)}
                          >
                            <FileDiff size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  {sec.rows.map((r) => {
                    const i = flat++;
                    return (
                      <div
                        key={r.key}
                        data-dragkey={r.key}
                        className={`sb-drag-item${dragKey === r.key ? ' is-drag' : ''}`}
                        onPointerDown={(e) => onRowPointerDown(e, r.key)}
                      >
                        <SidebarRow
                          row={r}
                          signal={rowSignalOf({
                            attention: attentionKeys.has(r.key),
                            // unread is session-only and stays out of the
                            // archived view (an inactive session's stale flag
                            // shouldn't mark history).
                            unread:
                              r.kind === 'session' &&
                              !!r.session?.active &&
                              unreadIds.has(r.key),
                          })}
                          badge={cmdHeld && i < 9 ? i + 1 : undefined}
                          canMoveUp={i > 0}
                          canMoveDown={i < displayRows.length - 1}
                          onMove={orderable && !grouped ? (dir) => moveRow(r.key, i, dir) : undefined}
                          onRenameRequest={() => setRenameTarget(r)}
                        />
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
            {dragKey && dropLineY != null && (
              <div className="sb-drop-line" style={{ top: dropLineY }} aria-hidden />
            )}
          </>
        )}
        {/* 已结束终端 (B-084): records pushed by new daemons. Not nav targets —
            the tmux session is gone; the ONE action re-opens a NEW terminal in
            the same directory (claude --resume finds the old conversation
            there). Disabled while the machine is offline / cwd unknown. */}
        {view === 'archived' && closedRows.length > 0 && (
          <div className="sb-section sb-closed-section">
            <div className="sb-section-head">
              <span className="sb-section-label">{t('sidebar.closedTerminals')}</span>
              <span className="sb-section-count mono">{closedRows.length}</span>
            </div>
            {closedRows.map((r) => (
              <div key={r.key} className="sb-row sb-closed-row">
                <div className="sb-row-main sb-closed-main">
                  <span className="sb-row-icon sb-row-icon--closed">
                    <TerminalSquare size={16} />
                  </span>
                  <span className="sb-row-text">
                    <span className="sb-row-title-line">
                      <span className="sb-row-title">{r.title}</span>
                    </span>
                    <span
                      className="sb-row-sub mono"
                      title={r.cwd ? `${r.cwd} · ${r.machineName}` : r.machineName}
                    >
                      {r.cwd ? `${r.cwd} · ` : ''}
                      {r.machineName} · {formatLastSeen(r.closedAt)}
                      {r.fromDaemonGap ? ` · ${t('sidebar.closedTerminalGap')}` : ''}
                    </span>
                  </span>
                </div>
                {/* B-105: a closed terminal that had a mirror keeps its
                    structured history reachable (M-4) — mirrors are hidden
                    from every list, so this link is the history's entry. */}
                {r.mirrorSessionId && (
                  <button
                    className="sb-closed-reopen"
                    title={t('sidebar.closedTerminalHistory')}
                    aria-label={t('sidebar.closedTerminalHistory')}
                    onClick={() => navigate(`/session/${r.mirrorSessionId}`)}
                  >
                    <MessagesSquare size={16} />
                  </button>
                )}
                {/* B-149: with a known claude session the action CONTINUES the
                    conversation (new terminal in cwd + `claude --resume`);
                    without one it stays the plain "same directory" open. */}
                <button
                  className="sb-closed-reopen"
                  disabled={!r.machineOnline || !r.cwd}
                  title={t(r.claudeSessionId ? 'sidebar.closedTerminalResume' : 'sidebar.closedTerminalReopen')}
                  aria-label={t(r.claudeSessionId ? 'sidebar.closedTerminalResume' : 'sidebar.closedTerminalReopen')}
                  onClick={() => createTerminalAt(navigate, r.machineId, r.cwd, r.claudeSessionId)}
                >
                  {r.claudeSessionId ? <RotateCcw size={16} /> : <Plus size={16} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="sb-footer">
        <button className="sb-footer-btn" onClick={() => navigate('/settings')}>
          <Settings size={16} /> <span>{t('tabs.settings')}</span>
        </button>
        {/* notes dock toggle (B-094) — app chrome, so it shares the footer row */}
        <button
          className="sb-footer-btn sb-footer-notes"
          onClick={toggleNotesPanel}
          aria-label={t('notes.title')}
          title={`${t('notes.title')} (⌘J)`}
        >
          <StickyNote size={16} />
        </button>
        {/* external todo panel (B-007) — same "app chrome" row as notes */}
        <button
          className="sb-footer-btn sb-footer-icon"
          onClick={() => navigate('/todos')}
          aria-label={t('todos.title')}
          title={t('todos.title')}
        >
          <ListChecks size={16} />
        </button>
        <QuickThemeToggle className="sb-footer-btn sb-footer-icon sb-theme-toggle" />
        {/* Notification center: bell + unread badge + panel (self-contained;
            the collapsed desktop rail carries its own instance). It used to
            sit in the header, which was overflowing as header-right icons
            accumulated — down here it shares the settings row, the other
            "app chrome" affordance. */}
        <NotificationBell className="sb-footer-bell" />
      </footer>

      {showNew && <NewSessionModal onClose={() => setShowNew(false)} />}
      {showNewTerminal && <NewTerminalModal onClose={() => setShowNewTerminal(false)} />}
      {renameTarget && (
        <RenameModal
          defaultTitle={renameTarget.title}
          tags={
            renameTarget.kind === 'session'
              ? renameTarget.session!.metadata?.tags ?? []
              : renameTarget.tags
          }
          suggestions={allTags}
          onClose={() => setRenameTarget(null)}
          onSave={async (title, tags) => {
            const target = renameTarget;
            // Shared flow writes only fields that actually changed.
            await saveRowRename(
              target.kind === 'terminal'
                ? {
                    kind: 'terminal',
                    terminalId: target.terminalId!,
                    currentTitle: target.title,
                    currentTags: target.tags,
                  }
                : { kind: 'session', session: target.session!, currentTitle: target.title },
              title,
              tags,
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * The row's actions as DATA — one definition consumed by BOTH the "…"
 * dropdown (all pointers) and the right-click context menu (fine pointers /
 * long-press). Icon, label, danger tone and disabled state live here only.
 */
function rowMenuItems(opts: {
  t: ReturnType<typeof useTranslation>['t'];
  isTerminal: boolean;
  supportsTags: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onRename: () => void;
  onMove?: (dir: -1 | 1) => void;
  onArchiveOrClose: () => void;
  /** B-091 priority marker; undefined hides it on old terminal daemons. */
  isPriority?: boolean;
  onTogglePriority?: () => void;
}): MenuItemDef[] {
  const { t } = opts;
  const items: MenuItemDef[] = [
    {
      key: 'rename',
      label: rowRenameMenuTranslationKeys(opts.supportsTags).map((key) => t(key)).join(' / '),
      icon: Pencil,
      onSelect: opts.onRename,
    },
  ];
  if (opts.onTogglePriority) {
    items.push({
      key: 'priority',
      label: t(opts.isPriority ? 'sidebar.unmarkPriority' : 'sidebar.markPriority'),
      icon: Flag,
      onSelect: opts.onTogglePriority,
    });
  }
  if (opts.onMove) {
    // Full-list adjacent swap — the reorder path for coarse pointers (no
    // touch drag), harmless extra on desktop.
    const move = opts.onMove;
    items.push(
      {
        key: 'move-up',
        label: t('sidebar.moveUp'),
        icon: ArrowUp,
        disabled: !opts.canMoveUp,
        onSelect: () => move(-1),
      },
      {
        key: 'move-down',
        label: t('sidebar.moveDown'),
        icon: ArrowDown,
        disabled: !opts.canMoveDown,
        onSelect: () => move(1),
      },
    );
  }
  // Archive-only (B-083): a chat session ends by archiving (records survive);
  // a terminal ends by a neutral "close" (tmux dies, the claude conversation
  // inside stays on the machine — `claude --resume`). No delete concept.
  items.push({
    key: 'archive',
    label: opts.isTerminal ? t('common.close') : t('common.archive'),
    icon: opts.isTerminal ? X : Archive,
    danger: !opts.isTerminal,
    separatorBefore: true,
    onSelect: opts.onArchiveOrClose,
  });
  return items;
}

function SidebarRow({
  row,
  signal,
  badge,
  canMoveUp,
  canMoveDown,
  onMove,
  onRenameRequest,
}: {
  row: Row;
  /** two-level marker (B-085): 'attention' = agent waiting on the user
   *  (accent rail + badge dot), 'unread' = finished-while-away (text-stage
   *  dot). Decided in the parent via rowSignalOf. */
  signal: RowSignal;
  badge?: number;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Adjacent swap in the full visible list — the menu reorder fallback for
   *  coarse pointers. undefined → reordering unavailable (archived view /
   *  search narrowing). */
  onMove?: (dir: -1 | 1) => void;
  onRenameRequest: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const isTerminal = row.kind === 'terminal';
  // Terminal rows are focused when the terminal route + tid match (they were
  // hardcoded unselected before, so the open terminal had no indicator).
  // A terminal can have two valid faces. Keep the row highlighted when the
  // user deliberately remains in raw xterm after the no-yank window, even if
  // a mirror appears later and future opens now prefer its structured href.
  const rawTerminalSelected = isTerminal
    && location.pathname === `/terminal/${encodeURIComponent(row.machineId!)}`
    && new URLSearchParams(location.search).get('tid') === row.terminalId;
  const selected = rawTerminalSelected || location.pathname === row.href;
  const s = row.session;

  // Claude agent state inside a web terminal (undefined = old daemon / no data
  // → keep the plain terminal icon, exactly the pre-agentState rendering).
  const agentState = useTerminalAgentStates((st) =>
    isTerminal && row.terminalId ? st.states[row.terminalId]?.state : undefined,
  );
  const agentDot =
    agentState === 'needs_input' ? ('permission' as const)
    : agentState === 'working' ? ('thinking' as const)
    : null; // idle / shell / undefined → current rendering, no extra dot
  const agentDotTitle =
    agentDot === 'permission' ? t('terminal.claudeNeedsInput') : t('terminal.claudeWorking');

  // status dot — gate "live/thinking" on the session actually being active so
  // ended/archived sessions never render as running (bug #6).
  const dot = isTerminal
    ? 'connected'
    : !s!.active
      ? 'offline'
      : (s!.agentState?.requests && Object.keys(s!.agentState.requests).length > 0)
        ? 'permission'
        : s!.thinking
          ? 'thinking'
          : s!.presence === 'online'
            ? 'connected'
            : 'offline';

  const open = () => navigate(row.href);

  // Archive (session) / close (terminal) — the flows, confirms included,
  // live in rowActions.ts and are shared with the board. Archive-only (B-083):
  // no delete flow exists for chat sessions.
  const onArchiveOrClose = async () => {
    if (isTerminal) {
      await confirmCloseTerminal(row.machineId!, row.terminalId!, () => {
        // Leaving the screen BEFORE the kill: a mounted terminal screen (or
        // a refresh on its URL) would otherwise re-open the id and recreate
        // the killed tmux session (see rowActions.confirmCloseTerminal).
        if (selected) navigate('/');
      });
      return;
    }
    const archived = await confirmArchiveSession(row.session!);
    // B-111: archiving the OPEN session used to leave you stranded on the
    // archived detail view — land on the next session instead.
    if (archived && selected) navigate(nextSessionPathAfterClose(row.session!.id));
  };

  // ONE item list feeds both the "…" dropdown and the right-click menu.
  const menuItems = rowMenuItems({
    t,
    isTerminal,
    supportsTags: !isTerminal || row.tags !== undefined,
    canMoveUp,
    canMoveDown,
    onRename: onRenameRequest,
    onMove,
    onArchiveOrClose: () => void onArchiveOrClose(),
    // B-091 标记优先/取消优先 — writes metadata.tags through the same
    // update-metadata op as the rename dialog (togglePriorityTag prepends the
    // tag, so the row also lands in the priority group when grouping is on).
    isPriority: hasPriorityTag(row.tags),
    onTogglePriority: isTerminal
      ? row.tags === undefined
        ? undefined
        : () =>
            useTerminalSessions
              .getState()
              .update(row.terminalId!, { tags: togglePriorityTag(row.tags) })
      : () => {
          void sessionUpdateTitleTags(s!.id, { tags: togglePriorityTag(s!.metadata?.tags) }).catch(
            () => {},
          );
        },
  });

  return (
    <ActionContextMenu items={menuItems}>
    <div
      className={`sb-row${selected ? ' is-selected' : ''}${
        signal === 'attention' ? ' sb-row--attention' : signal === 'unread' ? ' sb-row--unread' : ''
      }`}
    >
      {/* aria-current="page": the row IS a nav link to the open route, so SRs
          announce the selected row the same way the rail highlight shows it. */}
      <button
        className="sb-row-main"
        data-href={row.href}
        onClick={open}
        aria-current={selected ? 'page' : undefined}
      >
        <span className={`sb-row-icon${isTerminal ? ' sb-row-icon--term' : ''}`}>
          {isTerminal ? (
            <span className="sb-row-term-icon" title={agentDot ? agentDotTitle : undefined}>
              <TerminalSquare size={16} />
              {agentDot && (
                <span className="sb-row-agent-dot">
                  {/* pulse also on 待处理 (needs_input, machine online) —
                      reduced-motion users get the static dot (ui.css). */}
                  <StatusDot
                    status={agentDot}
                    pulse={agentDot === 'thinking' || signal === 'attention'}
                    size={7}
                    title={agentDotTitle}
                  />
                </span>
              )}
            </span>
          ) : (
            // 待处理 rows pulse too (permission dot); reduced-motion → static
            <StatusDot status={dot} pulse={dot === 'thinking' || signal === 'attention'} size={9} />
          )}
        </span>
        <span className="sb-row-text">
          <span className="sb-row-title-line">
            <span className="sb-row-title">{row.title}</span>
            {/* B-150: this tmux session and its processes are NEW — only the
                directory and the claude conversation carried over. Worth saying
                once, so a fresh scrollback isn't read as lost work. */}
            {row.restored && (
              <span className="sb-row-restored" title={t('sidebar.terminalRestoredHint')}>
                {t('sidebar.terminalRestored')}
              </span>
            )}
            {row.tags && row.tags.length > 0 && (
              <span className="sb-row-tags">
                {row.tags.slice(0, 2).map((tag) => (
                  <TagChip key={tag} tag={tag} small />
                ))}
                {row.tags.length > 2 && <TagOverflowChip count={row.tags.length - 2} small />}
              </span>
            )}
          </span>
          <span className="sb-row-sub mono">{row.subtitle}</span>
        </span>
        {/* right-edge signal dot: accent+glow = 待处理, text-stage = 未读.
            Sits INSIDE .sb-row-main (before the kebab column), so the
            hover-revealed kebab never covers it. */}
        {signal && (
          <span
            className={`sb-row-signal sb-row-signal--${signal}`}
            role="img"
            aria-label={t(signal === 'attention' ? 'sidebar.rowNeedsAttention' : 'sidebar.rowUnread')}
            title={t(signal === 'attention' ? 'sidebar.rowNeedsAttention' : 'sidebar.rowUnread')}
          />
        )}
        {badge != null && <kbd className="sb-row-badge mono">⌘{badge}</kbd>}
      </button>
      <ActionDropdownMenu items={menuItems} align="end" sideOffset={4}>
        <button className="sb-row-menu" aria-label="actions" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={16} />
        </button>
      </ActionDropdownMenu>
    </div>
    </ActionContextMenu>
  );
}
