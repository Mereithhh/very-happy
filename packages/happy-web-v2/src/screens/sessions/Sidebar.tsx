import { agentStatusSignal, codingAgentLabel, type AgentExecution } from '@/sync/agentStatus';
import { showsUnreadDot } from '@/sync/unreadTransition';
import type { RecentMachinePath } from '@/utils/quickChat';
import { BrandIcon, BrandEnvBadge } from '@/ui/BrandMark';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { isAppChord } from '@/app/appChord';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Plus, CircleHelp, Settings, TerminalSquare, HardDrive, MoreHorizontal, MessageSquare, MessagesSquare, PanelLeftClose, LayoutGrid, SlidersHorizontal, ArrowUp, ArrowDown, ChevronRight, Pencil, Archive, X, UsersRound, ArrowDownWideNarrow, ListOrdered, Flag, StickyNote, ListChecks, FolderOpen, Rows3, RotateCcw, Cable, Trash2, History, ChevronDown, CircleAlert, CircleHelp as UnknownStatus, Unplug, CodeXml, Asterisk, Pi, Zap, LocateFixed, FolderX, Eye, Moon, Contact, FolderKanban, FolderPlus, Tags } from 'lucide-react';
import { useSessions, useSetting, useLocalSetting, useLocalSettingMutable, useAllMachines, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createTerminalOrPick, createTerminalAt } from '@/app/newTerminal';
import { createChatOrConfigure, useNewChatPending } from '@/app/newChat';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { PendingSessionRows } from './PendingSessionRows';
import { getSessionName, getSessionSidebarSubtitle, formatLastSeen } from '@/utils/sessionUtils';
import { machineLabel, isMachineOnline } from '@/utils/machineUtils';
import { buildClosedTerminalRows, closedTerminalsOf, killAttachedSupported } from '@/sync/closedTerminals';
import { restoreClosedTerminal } from '@/app/rowActions';
import { confirmArchiveSession, nextSessionPathAfterClose, confirmCloseTerminal, confirmKillAttachedTerminal, saveRowRename, collectAllTags, restoreSessionOrAlert } from '@/app/rowActions';
import { canOfferRestore, useRestoreState } from '@/app/sessionRestore';
import { isHibernated } from '@/app/sessionHibernation';
import { sessionUpdateTitleTags } from '@/sync/ops';
import { priorityLevel, setPriorityLevel, sortByPriority, PRIORITY_LEVELS, priorityTag, type PriorityLevel } from '@/utils/tags';
import { flatListRows, sidebarListEmpty, visibleSidebarSessions } from './sidebarRows';
import { groupRowsByProject, foldersOfRows, legacyGroupModeFor, resolveSidebarGrouping, showTagGroupingBackNotice, type SidebarGrouping } from './sidebarProjectGroups';
import { groupRowsByTag } from './sidebarTagGroups';
import { applyLocalMembership, projectsApi, refreshProjects, useProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { MoveToProjectModal } from '@/screens/projects/MoveToProjectModal';
import type { ProjectView } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';
// aliased: `Settings` is already taken by the lucide gear icon above
import type { Settings as SyncedSettings } from '@/sync/settings';
import { StatusDot, QuickThemeToggle, TagChip, TagOverflowChip, ActionDropdownMenu, ActionContextMenu, Spinner, type MenuItemDef } from '@/ui';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { useIsDesktop } from '@/app/useMediaQuery';
import { useTranslation } from '@/i18n/useTranslation';
import { isImeGuardedEvent } from '@/utils/ime';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useActivityOverlay } from '@/sync/activityOverlayStore';
import { resolveActivityTs } from '@/sync/activityOverlay';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { useBoardItems } from '@/screens/board/useBoardItems';
import { fmtDuration } from '@/screens/board/boardItems';
import { boardProgressView } from '@/sync/boardProgress';
import { AUTOMATIONS_SIDEBAR_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import { automationsEntryVisible } from '@/sync/automationsPoll';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { openSessionSearch, SESSION_SEARCH_HINT } from '@/screens/search/sessionSearchEvents';
import { NewSessionModal } from './NewSessionModal';
import { NewTerminalModal } from './NewTerminalModal';
import { AttachTmuxModal } from './AttachTmuxModal';
import { ImportHistoryModal, type ImportHistoryAgent } from './ImportHistoryModal';
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
import { attentionSessionIds } from '@/screens/automations/automationPresentation';
import { rowRenameMenuTranslationKeys } from './sidebarRowMenu';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { resolveTerminalOpenPath } from '@/sync/terminalViewPref';
import { useTeamNavigation } from './useTeamNavigation';
import { botHistorySessionId, groupTeamNavigation, missingTeamSessionIds, teamInactiveGroupId, teamMemberCount, teamMemberInactive, teamSessionMembership, unstartedTeamMembers } from './teamNavigation';
import { useTeamNavigationCopy } from './teamNavigationCopy';
import type { TeamState } from '@slopus/happy-wire';
import './sidebar.css';
import { SidebarOrderHint } from './SidebarOrderHint';
import { sidebarNavEntries, navAttentionTotal, navMenuLabel, orderCreateMenu, sidebarTopModel, type SidebarNavKey } from './sidebarNavEntries';
import {
  findRevealTarget,
  isGroupCollapsed,
  nearestScrollTop,
  planReveal,
  setGroupCollapsed,
  summarizeGroup,
  withTemporaryExpanded,
  useCollapsedGroups,
  type GroupStatusSummary,
} from './sidebarCollapsedGroups';
import { SidebarRateLimit } from '@/screens/machine/rateLimits/SidebarRateLimit';
import { archiveAndDeleteWorktree, canArchiveAndDeleteWorktree } from '@/app/worktreeArchive';
import { worktreeCopy } from './worktreeCopy';
import { SessionPeek, peekDomId, useSessionPeek } from './SessionPeek';
import { SharedInvites } from './SharedInvites';
import { useFriendRequests } from '@/sync/storage';
import { useSessionShares } from '@/sync/sessionSharesStore';
import { Modal } from '@/modal';
import '../session/shared.css';
import { dismissFeatureTip, useFeatureTipAnchor } from '@/components/featureTips/FeatureTips';
import { BRAND } from '@/app/brand';

function rowHref(r: Row): string {
  return r.href;
}

/** 列表 (manual order) / 状态 (lifecycle groups) / 归档 — see the filter row. */
type View = 'list' | 'status' | 'archived';

interface Row {
  team?: TeamState;
  teamChild?: boolean;
  teamHistoryLink?: boolean;
  teamLabel?: string;
  /** B-674/B-690: the 「已停用 N 个」 fold row under an expanded team (not a nav target, no ⌘N slot). */
  teamInactiveFold?: { teamId: string; count: number; open: boolean };
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
  /** B-486: temporary direct shell (machine has no tmux). */
  direct?: boolean;
  /** B-273/B-282: terminal attached to this user tmux session (name). */
  attachTmux?: string;
  /** B-619: session shared WITH me — owner's name + my role. Such rows live in their own group. */
  share?: { owner: string; role: 'viewer' | 'driver'; grantId: string };
}

interface SidebarSection {
  id: string;
  label: string | undefined;
  count: number;
  /** VISIBLE rows ([] while collapsed) */
  rows: Row[];
  /** every row of the group — the collapsed-header summary and reveal read it (B-580) */
  allRows: Row[];
  collapsible: boolean;
  open: boolean;
  detail?: string;
  createLocation?: RecentMachinePath;
  /** B-647: a project group (header shows 等你处理 instead of a row count). */
  project?: ProjectView;
  attention?: number;
  /** B-647: small label above the first 未归属 folder group. */
  kicker?: string;
  /** B-647: 「设为项目」 for an unassigned folder group. */
  makeProject?: { name: string; machineId: string; path: string; sessionIds: string[] };
  /** B-675: 「转成项目」 for a tag group (the tag→project action kept from B-647). */
  tagToProject?: string;
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
    ...(s.share ? { share: { owner: s.share.owner.displayName, role: s.share.role, grantId: s.share.grantId } } : {}),
  };
}

export function Sidebar() {
  const navigate = useNavigate();
  const sessions = useSessions();
  const teams = useTeamNavigation();
  const teamCopy = useTeamNavigationCopy();
  const incomingPeople = useFriendRequests().length;
  const happyBotEntryVisible = useLocalSetting('happyBotEntryVisible');
  // B-498/B-504: the Automations entry is visible unless the server said
  // 404 automations_disabled (the feature is open to everyone); the badge is
  // the count of runs waiting for a decision. One slow poll here feeds both.
  const automationsEnabled = useAutomations((s) => automationsEntryVisible(s.enabled));
  const automationAttentionRuns = useAutomations((s) => s.attention);
  const automationAttention = automationAttentionRuns.length;
  // B-508: sessions some flagged run is about (its own or payload-named) get a marker on their row.
  const automationAttentionKeys = useMemo(() => attentionSessionIds(automationAttentionRuns), [automationAttentionRuns]);
  const refreshAutomations = useAutomations((s) => s.refreshOverview);
  useAutomationsPoll(refreshAutomations, AUTOMATIONS_SIDEBAR_POLL_MS);
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set());
  const location = useLocation();
  const currentSessionId = /^\/session\/([^/]+)/.exec(location.pathname)?.[1];
  const currentTeamId = currentSessionId ? teamSessionMembership(teams).get(decodeURIComponent(currentSessionId))?.team.id : undefined;
  useEffect(() => {
    if (currentTeamId) setExpandedTeams((current) => current.has(currentTeamId) ? current : new Set([...current, currentTeamId]));
  }, [currentTeamId]);
  const { t, lang } = useTranslation();
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
  const [newLocation, setNewLocation] = useState<RecentMachinePath>();
  const configureNew = (target?: RecentMachinePath) => { setNewLocation(target); setShowNew(true); };
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [showAttachTmux, setShowAttachTmux] = useState(false);
  const [showImport, setShowImport] = useState<ImportHistoryAgent | null>(null);
  const [cmdHeld, setCmdHeld] = useState(false);
  const [showOrderHint, setShowOrderHint] = useState(false);
  const terminals = useTerminalSessions((s) => s.terminals);
  const terminalViewDefault = useLocalSetting('terminalViewDefault');
  const terminalViewOverrides = useLocalSetting('terminalViewOverrides');
  const toggleCollapsed = useSidebarPrefs((s) => s.toggleCollapsed);
  const isDesktop = useIsDesktop();

  // Terminal list/agent-state ingestion lives in the AppLayout-level singleton
  // (sync/terminalSync.ts: daemon pushes) so it also runs with the sidebar
  // collapsed or on mobile detail screens. This component is a pure consumer
  // of its stores.


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
  // B-647: the lens is `sidebarGrouping`, project by default. B-675 (Owner
  // 2026-10-21) brought tag grouping back beside it: 项目 / 标签 / 不分组.
  // The pre-B-647 fields are only read for the one-time notice and mirrored
  // so a Web rollback still shows a sensible lens.
  const [groupByTag, setGroupByTag] = useLocalSettingMutable('sidebarGroupByTag');
  const [savedGroupMode, setSavedGroupMode] = useLocalSettingMutable('sidebarGroupMode');
  const [grouping, setGrouping] = useLocalSettingMutable('sidebarGrouping');
  const [tagNoticeDismissed, setTagNoticeDismissed] = useLocalSettingMutable('tagGroupingBackNoticeDismissed');
  const groupMode = resolveSidebarGrouping(grouping);
  const grouped = orderable && groupMode !== 'none';
  const selectGroupMode = useCallback((mode: SidebarGrouping) => {
    setGrouping(mode);
    const legacy = legacyGroupModeFor(mode);
    setSavedGroupMode(legacy.sidebarGroupMode);
    if (groupByTag !== legacy.sidebarGroupByTag) setGroupByTag(legacy.sidebarGroupByTag);
    if (mode === 'tag') setTagNoticeDismissed(true);
  }, [setGrouping, setSavedGroupMode, groupByTag, setGroupByTag, setTagNoticeDismissed]);
  const projectsSnap = useProjects();
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
  // §7: closed-terminal restore is an RPC round-trip (seconds); track in-flight
  // ids so the reopen button shows a spinner (only the restore-in-place path;
  // the createTerminalAt fallback navigates instantly).
  const [restoringTerminals, setRestoringTerminals] = useState<Set<string>>(() => new Set());

  const rows = useMemo<Row[] | null>(() => {
    if (!sessions) return null;
    // visibleSidebarSessions also excludes the assistant meta-session (B-091
    // leak fix: this inline filter used to miss it — regression-tested in
    // sidebarRows.test.ts). Applies to the archived view too.
    // B-619: sessions shared WITH me are listed in their own group (sharedRows),
    // never ordered / grouped with my own.
    const sessRows = visibleSidebarSessions(sessions, view).filter((s) => !s.share).map(sessionRow);
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
            sessionId: tm.mirrorSessionId ?? undefined,
            machineId: tm.machineId,
            machineName: tm.machineName,
            workspacePath: tm.cwd,
            title: tm.title || tm.machineName,
            tags: tm.tags,
            subtitle: `${tm.machineName} · terminal`,
            restored: !!tm.restoredAt,
            direct: tm.direct === true,
            attachTmux: tm.attachTmux,
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
  const creatingChat = useNewChatPending();
  const executionByKey = useMemo(() => new Map(boardItems.map(item => [item.key,
    item.status === 'working' ? (item.backgroundTasks ? 'background' : 'running') : item.status === 'attention' ? 'input' : item.status === 'unknown' ? 'unknown' : item.status === 'ended' ? 'offline' : 'idle'] as [string, AgentExecution])), [boardItems]);
  // B-507: the count behind a `background` verdict, for the row's status label.
  const backgroundCountByKey = useMemo(() => new Map(boardItems.flatMap(item => item.backgroundTasks ? [[item.key, item.backgroundTasks] as [string, number]] : [])), [boardItems]);
  // B-465: rows whose status is an estimate from an old daemon get a note.
  const legacyStatusKeys = useMemo(() => new Set(boardItems.filter(item => item.legacyStatus).map(item => item.key)), [boardItems]);
  // B-558: an expired lease says how long nothing arrived, instead of a verdict.
  const noUpdateSinceByKey = useMemo(() => new Map(boardItems.flatMap(item => item.noUpdateSince !== undefined ? [[item.key, item.noUpdateSince] as [string, number]] : [])), [boardItems]);
  const attentionCount = boardItems.filter(item => item.status === 'attention').length;

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
  // B-330: terminals carry the same 未读 dot, owned by the store that observes
  // their transitions (sync/terminalAgentState.ts).
  const unreadTerminalIds = useTerminalAgentStates((s) => s.unread);

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
  // B-580: every labelled group is collapsible; state is device-local
  // (sidebarCollapsedGroups.ts). 已完成 keeps its collapsed-by-default.
  // `collapsedGroups` = persisted choices + the in-memory reveal override
  // (groups temporarily opened to show the current row; cleared on route change).
  const storedCollapsedGroups = useCollapsedGroups();
  const [revealExpanded, setRevealExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const collapsedGroups = useMemo(() => withTemporaryExpanded(storedCollapsedGroups, revealExpanded), [storedCollapsedGroups, revealExpanded]);
  const completedOpen = !isGroupCollapsed(collapsedGroups, 'completed');
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
        ...(isGroupCollapsed(collapsedGroups, 'waiting') ? [] : statusGroups.waiting),
        ...(isGroupCollapsed(collapsedGroups, 'running') ? [] : statusGroups.running),
        ...(completedOpen ? completedRows : []),
      ];
    }
    if (!orderable) return rows; // 归档: plain activity list, unchanged
    // 列表: whatever base order applies, `priority`-tagged rows float on top
    // as a stable partition (B-091) — an explicit user marker outranks both
    // the activity sort and the manual arrangement. (状态 gets the same
    // effect via the board's comparator; 归档 stays plain history.)
    const priorityFirst = (list: Row[]) => sortByPriority(list, (r) => priorityLevel(r.tags));
    // recent mode: one mixed sequence by last activity, hold applied.
    if (sortMode === 'recent') return applyReorderHold(heldKeys, priorityFirst(sortRowsByRecent(rows)));
    if ((orderSetting ?? []).length > 0) return priorityFirst(sortRowsByManualOrder(rows, orderSetting!));
    const { pinned, rest } = splitPinnedRows(rows, pinnedSetting ?? []);
    return priorityFirst([...pinned, ...rest]);
  }, [rows, view, statusGroups, completedRows, completedOpen, collapsedGroups, orderSetting, pinnedSetting, orderable, sortMode, heldKeys]);
  // ----- teams (B-480) and the project lens (B-647) -----
  const liveTeams = useMemo(() => teams.filter((team) => !team.archivedAt), [teams]);
  // Receipt-backed team sessions that are no longer in the visible list keep a history link.
  const teamHistoryRows = useMemo<Row[]>(() => {
    if (!orderedRows || liveTeams.length === 0) return [];
    const membership = teamSessionMembership(liveTeams);
    const existingIds = new Set(orderedRows.flatMap(row => row.sessionId ? [row.sessionId] : []));
    return missingTeamSessionIds(existingIds, liveTeams).map((sessionId): Row => {
      const { bot } = membership.get(sessionId)!;
      return { key: sessionId, sessionId, kind: 'session', href: `/session/${encodeURIComponent(sessionId)}`, title: bot.name, subtitle: teamCopy.history, ts: 0, createdAt: 0, teamHistoryLink: true };
    });
  }, [orderedRows, liveTeams, teamCopy.history]);
  // B-674/B-690: inactive members (happy-wire teamBotActivity — no open task
  // and no session / archived conversation / exited / idle for 7 days) fold behind one 「已停用 N 个」 row per team, collapsed by default; the
  // choice is device-local (sidebarCollapsedGroups, `team-archived:<id>`) and
  // shared with the Teams page. Opening an inactive member's session reveals
  // the fold for that route only.
  // A member conversation missing from the active list is archived (B-674's signal).
  const memberContext = useMemo(() => {
    const existingIds = new Set((orderedRows ?? []).flatMap(row => row.sessionId ? [row.sessionId] : []));
    return { sessionArchived: (sessionId: string) => !existingIds.has(sessionId) };
  }, [orderedRows]);
  const inactiveMembers = useMemo(() => {
    const sessions = new Set<string>();
    const unstarted = new Map<string, Set<string>>();
    if (!orderedRows || liveTeams.length === 0) return { sessions, unstarted };
    for (const team of liveTeams) for (const bot of team.bots) {
      if (!teamMemberInactive(team, bot, memberContext)) continue;
      const sessionId = botHistorySessionId(team, bot);
      if (sessionId) sessions.add(sessionId);
      else unstarted.set(team.id, new Set([...(unstarted.get(team.id) ?? []), bot.id]));
    }
    return { sessions, unstarted };
  }, [orderedRows, liveTeams, memberContext]);
  const inactiveOpenTeams = useMemo(
    () => new Set(liveTeams.filter((team) => !isGroupCollapsed(collapsedGroups, teamInactiveGroupId(team.id))).map((team) => team.id)),
    [liveTeams, collapsedGroups],
  );
  /** Team header + (expanded) member rows in place of the members, ordinary rows untouched. */
  const nestTeams = useCallback((groupRows: Row[], groupTeams: TeamState[]): Row[] => {
    if (groupTeams.length === 0) return groupRows;
    const pendingRow = (team: TeamState) => ({bot, task, failed, href}: ReturnType<typeof unstartedTeamMembers>[number]): Row => ({ key: `member:${team.id}:${bot.id}`, kind: 'session', href, title: bot.root ? teamCopy.lead : bot.name, subtitle: failed ? teamCopy.failed : task ? teamCopy.preparing : teamCopy.noSession, ts: team.createdAt, createdAt: team.createdAt, teamHistoryLink: true });
    const unstarted = (team: TeamState, inactive: boolean) => unstartedTeamMembers(team).filter(({ bot }) => (inactiveMembers.unstarted.get(team.id)?.has(bot.id) ?? false) === inactive);
    const fold = {
      isInactive: (r: Row) => !!r.sessionId && inactiveMembers.sessions.has(r.sessionId),
      open: inactiveOpenTeams,
      extra: (team: TeamState) => inactiveMembers.unstarted.get(team.id)?.size ?? 0,
    };
    return groupTeamNavigation(groupRows, groupTeams, expandedTeams, fold).flatMap((entry): Row[] => {
      if (entry.kind === 'inactive') return [
        { key: teamInactiveGroupId(entry.team.id), kind: 'session', href: `/teams/${encodeURIComponent(entry.team.id)}`, title: teamCopy.inactiveCount(entry.count), subtitle: '', ts: 0, createdAt: 0, teamInactiveFold: { teamId: entry.team.id, count: entry.count, open: entry.open } },
        ...(entry.open ? unstarted(entry.team, true).map(pendingRow(entry.team)) : []),
      ];
      if (entry.kind === 'row') return [entry.team ? { ...entry.row, teamChild: true, href: `/session/${encodeURIComponent(entry.row.sessionId!)}`, teamLabel: entry.bot?.root ? teamCopy.lead : entry.bot?.name || teamCopy.member } : entry.row];
      const header: Row = { key: `team:${entry.team.id}`, kind: 'session', href: `/teams/${encodeURIComponent(entry.team.id)}`, title: entry.team.name, subtitle: '', ts: entry.team.createdAt, createdAt: entry.team.createdAt, team: entry.team };
      const pending: Row[] = expandedTeams.has(entry.team.id) ? unstarted(entry.team, false).map(pendingRow(entry.team)) : [];
      return [header, ...pending];
    });
  }, [expandedTeams, inactiveOpenTeams, inactiveMembers, teamCopy]);
  // Default lens: project groups, then 未归属 sub-grouped by folder. Teams nest
  // inside their group, so they stay visible while grouped (spec §6.1).
  const projectGrouping = useMemo(
    () => (orderable && groupMode === 'project' && orderedRows
      ? groupRowsByProject([...orderedRows, ...teamHistoryRows], projectsSnap.projects, projectsSnap.members, liveTeams)
      : null),
    [orderable, groupMode, orderedRows, teamHistoryRows, projectsSnap.projects, projectsSnap.members, liveTeams],
  );
  const projectSections = useMemo<SidebarSection[] | null>(() => {
    if (!projectGrouping) return null;
    const out: SidebarSection[] = [];
    const sessionCount = (groupRows: Row[]) => groupRows.filter((r) => !r.teamHistoryLink).length;
    for (const g of projectGrouping.projects) {
      const primary = g.project.folders.find((f) => f.primary) ?? g.project.folders[0];
      out.push({
        ...collapsibleSection(`project:${g.project.id}`, g.project.name, nestTeams(g.rows, g.teams), collapsedGroups),
        count: sessionCount(g.rows),
        project: g.project,
        attention: g.rows.filter((r) => attentionKeys.has(r.key)).length,
        ...(primary ? { createLocation: { machineId: primary.machineId, path: primary.path }, detail: primary.path } : {}),
      });
    }
    const unassignedLabel = t('sidebar.projectsUnassigned') as string;
    projectGrouping.unassigned.forEach((g, i) => {
      const sessionIds = g.rows.flatMap((r) => (r.kind === 'session' && r.sessionId && !r.share && !r.teamHistoryLink ? [r.sessionId] : []));
      out.push({
        ...collapsibleSection(workspaceGroupId(g), g.name ?? (t('sidebar.workspaceUnassigned') as string), nestTeams(g.rows, g.teams), collapsedGroups),
        count: sessionCount(g.rows),
        detail: [g.machineName, g.path].filter(Boolean).join(' · '),
        createLocation: g.machineId && g.path ? { machineId: g.machineId, path: g.rows.find(r => r.workspacePath)?.workspacePath ?? g.path } : undefined,
        kicker: i === 0 && projectGrouping.projects.length > 0 ? unassignedLabel : undefined,
        makeProject: projectsSnap.status === 'ready' && g.machineId && g.path && sessionIds.length > 0 ? { name: g.name ?? g.path, machineId: g.machineId, path: g.path, sessionIds } : undefined,
      });
    });
    // B-708: teams with no located row (new, or every member archived) show
    // once here — never as one 「无工作目录」 group per history link.
    const tg = projectGrouping.teamsGroup;
    if (tg) {
      const first = projectGrouping.unassigned.length === 0;
      out.push({
        ...collapsibleSection('unassigned:teams', first ? unassignedLabel : teamCopy.title, nestTeams(tg.rows, tg.teams), collapsedGroups),
        count: sessionCount(tg.rows),
      });
    }
    return out;
  }, [projectGrouping, nestTeams, collapsedGroups, attentionKeys, projectsSnap.status, teamCopy.title, t]);
  // B-675: 按标签 — one group per first tag (priority P0-P2 first, 未分组 last).
  // Teams have no tags, so their members and history links leave the tag
  // groups and nest under one trailing 「团队」 group instead of being dropped.
  const tagSections = useMemo<SidebarSection[] | null>(() => {
    if (!orderable || groupMode !== 'tag' || !orderedRows) return null;
    const membership = liveTeams.length > 0 ? teamSessionMembership(liveTeams) : null;
    const isTeamRow = (r: Row) => !!membership && !!r.sessionId && membership.has(r.sessionId);
    const out: SidebarSection[] = groupRowsByTag(orderedRows.filter((r) => !isTeamRow(r))).map((g) => ({
      ...collapsibleSection(tagGroupId(g), g.tag ?? (t('sidebar.groupUntagged') as string), g.rows, collapsedGroups),
      ...(g.tag && projectsSnap.status === 'ready' ? { tagToProject: g.tag } : {}),
    }));
    if (liveTeams.length > 0) {
      const teamRows = [...orderedRows.filter(isTeamRow), ...teamHistoryRows];
      out.push({ ...collapsibleSection('teams:tag-lens', teamCopy.title, nestTeams(teamRows, liveTeams), collapsedGroups), count: teamRows.filter((r) => !r.teamHistoryLink).length });
    }
    return out;
  }, [orderable, groupMode, orderedRows, liveTeams, teamHistoryRows, nestTeams, collapsedGroups, projectsSnap.status, teamCopy.title, t]);
  const groupedSections = projectSections ?? tagSections;
  // Collapsed groups' rows are not rendered, so they take no ⌘1-9 number
  // and no move-up/down position either (B-580).
  const plainDisplayRows = useMemo<Row[] | null>(
    () => (groupedSections ? groupedSections.flatMap((sec) => sec.rows).filter((r) => !r.teamInactiveFold) : orderedRows),
    [groupedSections, orderedRows],
  );
  // The flat list (不分组) nests teams over the whole list; the project and tag lenses do it per group.
  const teamHistory = view === 'list' && !grouped && liveTeams.length > 0;
  // B-619: 「分享给我的」 — a trailing group in every view mode; not draggable, no ⌘N badge.
  const sharedRows = useMemo<Row[]>(
    () => (sessions ? sortRowsByRecent(visibleSidebarSessions(sessions, view).filter((s) => !!s.share).map(sessionRow)) : []),
    [sessions, view],
  );
  // B-710: the flat list renders the inactive-member folds (`flatRows`) but
  // numbers / reorders only the sequence without them (`displayRows`).
  const flatRows = useMemo(() => {
    if (!plainDisplayRows || !teamHistory) return plainDisplayRows ? { rendered: plainDisplayRows, sequence: plainDisplayRows } : null;
    return flatListRows(nestTeams([...plainDisplayRows, ...teamHistoryRows], liveTeams));
  }, [plainDisplayRows, teamHistory, teamHistoryRows, liveTeams, nestTeams]);
  const displayRows = flatRows?.sequence ?? null;
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
    if (!orderable || grouped || teamHistory) return;
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
      // B-265: archived sessions and closed terminals are restorable, so their
      // order/pin entries must survive the archive — only ids that are gone
      // from the store / every machine's records are pruned.
      const valid = new Set<string>(Object.keys(st.sessions));
      for (const tm of useTerminalSessions.getState().terminals) valid.add(`t:${tm.id}`);
      for (const m of Object.values(st.machines)) {
        for (const r of closedTerminalsOf(m.daemonState)) valid.add(`t:${r.id}`);
      }
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
        const target = rowsRef.current?.find((r) => !r.team && !r.teamHistoryLink && rowHref(r) === cur);
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
    // B-619: shared-with-me rows always tail the list as their own labelled group.
    const shared: SidebarSection[] = sharedRows.length > 0 ? [collapsibleSection('shared', t('sidebar.groupShared'), sharedRows, collapsedGroups)] : [];
    if (view === 'status' && statusGroups) {
      return [
        collapsibleSection('waiting', t('sidebar.groupWaiting'), statusGroups.waiting, collapsedGroups),
        collapsibleSection('running', t('sidebar.groupRunning'), statusGroups.running, collapsedGroups),
        collapsibleSection('completed', t('sidebar.groupDoneToday'), completedRows, collapsedGroups),
        ...shared,
      ];
    }
    // 列表 + 按项目 (B-647, default): project groups, then 未归属 folder groups.
    // 列表 + 按标签 (B-675): first-tag groups, 未分组, then 团队.
    if (groupedSections) return [...groupedSections, ...shared];
    return [
      {
        id: 'all',
        label: undefined as string | undefined,
        count: displayRows?.length ?? 0,
        rows: flatRows?.rendered ?? [],
        allRows: flatRows?.rendered ?? [],
        collapsible: false,
        open: true,
      },
      ...shared,
    ];
  }, [view, statusGroups, completedRows, collapsedGroups, groupedSections, displayRows, flatRows, sharedRows, t]);

  // ----- collapsed-header status summary (B-580) -----
  // Same inputs as the row's own status slot (SidebarRow → agentStatusSignal),
  // so a folded group still shows 等待操作 / 运行中 / 未读 counts.
  const rowStatusOf = useCallback((r: Row) => {
    const execution = executionByKey.get(r.key) ?? (r.session?.presence === 'online' ? 'idle' : 'offline');
    const unread = (r.kind === 'session' && showsUnreadDot(r.session, unreadIds))
      || (r.kind === 'terminal' && !!r.terminalId && unreadTerminalIds.has(r.terminalId));
    return agentStatusSignal(execution, rowSignalOf({ attention: attentionKeys.has(r.key), unread }) === 'unread');
  }, [executionByKey, unreadIds, unreadTerminalIds, attentionKeys]);

  // ----- reveal the current row (B-580) -----
  // On every route change (⌘K, notification, deep link, click) and on mount:
  // expand the group holding the current row if it is folded, then scroll the
  // row into the sidebar's OWN list (nearest edge; no scrollIntoView, which
  // would also scroll ancestors). Only route changes arm it, so folding the
  // current row's group afterwards sticks. "定位当前会话" re-arms it by hand.
  const isCurrentRow = useCallback((r: Row) => {
    if (r.team || r.teamHistoryLink) return false;
    if (location.pathname === r.href || `${location.pathname}${location.search}` === r.href) return true;
    return r.kind === 'terminal'
      && location.pathname === `/terminal/${encodeURIComponent(r.machineId ?? '')}`
      && new URLSearchParams(location.search).get('tid') === r.terminalId;
  }, [location.pathname, location.search]);
  const onRowRoute = Boolean(currentSessionId) || location.pathname.startsWith('/terminal/');
  const [revealSeq, setRevealSeq] = useState(1);
  const revealHandled = useRef(0);
  const revealManual = useRef(false);
  const dataReady = storage((st) => st.isDataReady);
  useEffect(() => {
    setRevealExpanded((cur) => (cur.size ? new Set() : cur)); // temporary opens end with the route
    setRevealSeq((n) => n + 1);
  }, [location.pathname, location.search]);
  // B-674: declared after the route-change reset above, so its reveal survives the same commit.
  const inactiveRevealRoute = useRef('');
  useEffect(() => {
    const route = location.pathname;
    if (!currentTeamId || inactiveRevealRoute.current === route) return;
    if (!inactiveMembers.sessions.has(decodeURIComponent(currentSessionId ?? ''))) return;
    inactiveRevealRoute.current = route;
    const id = teamInactiveGroupId(currentTeamId);
    setRevealExpanded((cur) => (cur.has(id) ? cur : new Set([...cur, id])));
  }, [location.pathname, currentTeamId, currentSessionId, inactiveMembers]);
  const locateCurrent = useCallback(() => { revealManual.current = true; setRevealSeq((n) => n + 1); }, []);
  useEffect(() => {
    if (displayRows === null) return;
    const target = findRevealTarget(
      sections.map((sec) => ({ id: sec.id, collapsible: sec.collapsible, keys: sec.allRows })),
      isCurrentRow,
      (id) => isGroupCollapsed(collapsedGroups, id),
    );
    const step = planReveal({
      armed: revealHandled.current !== revealSeq,
      dataReady,
      found: target !== null,
      expand: target?.expand ?? false,
      manual: revealManual.current,
      inListView: view === 'list',
    });
    if (step === 'idle' || step === 'wait') return;
    if (step === 'switch-to-list') {
      // Asked by hand but the row isn't in this view (e.g. 归档 while the
      // session is active): one retry in the list view. The flag is cleared
      // NOW, so a second miss ends the pass instead of pinning the list view.
      revealManual.current = false;
      selectView('list');
      return;
    }
    if (step === 'expand') {
      // Memory-only: never persisted, so 已完成's default fold and the user's own folds survive.
      setRevealExpanded((cur) => new Set([...cur, target!.sectionId]));
      return; // next render scrolls
    }
    revealHandled.current = revealSeq;
    revealManual.current = false;
    if (step === 'done' || !target) return;
    const key = target.key.key;
    const raf = requestAnimationFrame(() => {
      const list = listRef.current;
      const el = list?.querySelector<HTMLElement>(`[data-dragkey="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key}"]`);
      if (!list || !el) return;
      const lr = list.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const top = nearestScrollTop({ containerTop: lr.top, containerHeight: list.clientHeight, scrollTop: list.scrollTop, rowTop: er.top, rowHeight: er.height });
      if (top !== null) list.scrollTop = top;
    });
    return () => cancelAnimationFrame(raf);
  }, [revealSeq, sections, displayRows, isCurrentRow, collapsedGroups, view, selectView, dataReady]);

  // Quick create: spawns directly with the remembered machine/directory and
  // the settings defaults; falls back to the full dialog only when it can't
  // decide (or always-ask is on). Shared by the desktop 新建会话 button and the
  // phone header's ＋ (B-641) — same menu, same first item, same step count.
  // ----- project actions (B-647) -----
  const makeProjectFrom = useCallback(async (spec: { name: string; machineId: string; path: string; sessionIds: string[] }) => {
    try {
      const { project } = await projectsApi.create({ name: spec.name.slice(0, 120), folders: [{ machineId: spec.machineId, path: spec.path, primary: true }], sessionIds: spec.sessionIds.slice(0, 200), requestId: `folder:${spec.machineId}:${spec.path}:${spec.sessionIds.length}` });
      applyLocalMembership(project.id, spec.sessionIds);
      toast.success(t('sidebar.makeProjectDone', { name: project.name }) as string);
    } catch {
      toast.error(t('sidebar.makeProjectFailed') as string);
    } finally {
      void refreshProjects();
    }
  }, [t]);
  const createNamedProject = useCallback(async () => {
    const name = (await Modal.prompt(t('sidebar.newProject') as string, t('sidebar.newProjectPrompt') as string))?.trim();
    if (!name) return;
    await makeProjectFromRows(name, []);
  }, [t]);
  /** Project from a set of rows: folders = their machine+path pairs, the first one primary. */
  const makeProjectFromRows = useCallback(async (name: string, sourceRows: Row[]) => {
    const folders = foldersOfRows(sourceRows).map((f, i) => ({ ...f, primary: i === 0 }));
    const sessionIds = sourceRows.flatMap((r) => (r.kind === 'session' && r.sessionId && !r.share ? [r.sessionId] : []));
    try {
      const { project } = await projectsApi.create({ name: name.slice(0, 120), folders, sessionIds: sessionIds.slice(0, 200) });
      if (sessionIds.length) applyLocalMembership(project.id, sessionIds);
      toast.success(t('sidebar.makeProjectDone', { name: project.name }) as string);
    } catch {
      toast.error(t('sidebar.makeProjectFailed') as string);
    } finally {
      void refreshProjects();
    }
  }, [t]);
  const convertTagToProject = useCallback(async (tag: string) => {
    const key = tag.toLowerCase();
    await makeProjectFromRows(tag, (orderedRows ?? []).filter((r) => r.tags?.[0]?.trim().toLowerCase() === key));
  }, [orderedRows, makeProjectFromRows]);
  const tagNoticeVisible = orderable && showTagGroupingBackNotice({ sidebarGrouping: grouping, sidebarGroupMode: savedGroupMode, sidebarGroupByTag: groupByTag, tagGroupingBackNoticeDismissed: tagNoticeDismissed });

  const [moveProjectTarget, setMoveProjectTarget] = useState<{ sessionId: string; candidates: { sessionId: string; title: string }[] } | null>(null);
  // B-676: 新会话 first, 新项目 second (orderCreateMenu) — on the phone ＋ they are the top two rows.
  const createItems: MenuItemDef[] = orderCreateMenu([
    ...(projectsSnap.status === 'ready' ? [{
      // B-647: 新建 ▾ → 新项目 (name only; folders and defaults live on the project page).
      key: 'project',
      label: t('sidebar.newProject'),
      icon: FolderKanban,
      onSelect: () => void createNamedProject(),
    } satisfies MenuItemDef] : []),
    {
      key: 'chat',
      disabled: creatingChat,
      label: t('newSessionModal.chatTitle'),
      icon: MessageSquare,
      onSelect: () => void createChatOrConfigure(navigate, configureNew, { location }),
    },
    {
      key: 'advanced',
      label: t('newSessionModal.advancedTitle'),
      icon: SlidersHorizontal,
      onSelect: () => configureNew(),
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
    {
      // B-281: the dedicated picker — lists the machine's OWN tmux
      // sessions directly, click = attach (B-273 machinery).
      key: 'terminal-attach',
      label: t('newSessionModal.terminalAttachTitle'),
      icon: Cable,
      onSelect: () => setShowAttachTmux(true),
    },
    {
      // B-290: import a Claude Code conversation (CLI / desktop app /
      // claude.ai) that was never started through very-happy.
      key: 'import-claude',
      label: t('newSessionModal.importClaudeTitle'),
      icon: History,
      onSelect: () => setShowImport('claude'),
    },
    {
      // B-464: same dialog, Codex source (codex TUI / exec / desktop).
      key: 'import-codex',
      label: t('newSessionModal.importCodexTitle'),
      icon: History,
      onSelect: () => setShowImport('codex'),
    },
    {
      // B-300: everything above needs a machine, so the way to get
      // one belongs in the same menu — separated, because it creates
      // no session. B-296 gave it a page; this is where people look.
      key: 'connect-machine',
      label: t('connectMachine.cta'),
      icon: HardDrive,
      separatorBefore: true,
      onSelect: () => navigate('/machine/connect'),
    },
  ]);

  // B-641/B-676: secondary entries live in the header ⋯ menu on every device.
  const top = sidebarTopModel({ isDesktop, projectsReady: projectsSnap.status === 'ready' });
  const newRowRef = useRef<HTMLDivElement | null>(null);
  const [newRowWidth, setNewRowWidth] = useState<number>();
  const navEntries = sidebarNavEntries({ teamsVisible: happyBotEntryVisible, automationsVisible: automationsEnabled, automationAttention, incomingPeople });
  const navAttention = navAttentionTotal(navEntries);
  const navName: Record<SidebarNavKey, string> = {
    teams: teamCopy.title,
    automations: t('automations.sidebarEntry'),
    todos: t('todos.title'),
    people: t('people.title'),
    help: t('sidebar.openHelp'),
  };
  const navIcon = { teams: UsersRound, automations: Zap, todos: ListChecks, people: Contact, help: CircleHelp } as const;

  return (
    <div className="sb">
      <header className="sb-header">

        <button className="sb-brand sb-brand--button" type="button" onClick={() => navigate('/help')} title={t('sidebar.openHelp')} aria-label={t('sidebar.openHelp')}>
          <BrandIcon size={18} /><span>{BRAND.name}</span><BrandEnvBadge />
        </button>
        <div className="sb-header-right">
          {/* B-650: 🔍 opens the session search (spec 2026-10-projects §7); ⌘K stays the quick jump. */}
          {top.header.includes('search') && <button className="sb-icon-btn" aria-label={t("sessionSearch.title")} title={`${t("sessionSearch.title")} · ${SESSION_SEARCH_HINT}`} onClick={openSessionSearch}><Search size={17}/></button>}
          {/* B-641: the phone list keeps its height — new session lives in the header ＋. */}
          {top.header.includes('create-menu') && (
            <ActionDropdownMenu align="end" sideOffset={4} items={createItems}>
              <button className="sb-icon-btn sb-new-icon" disabled={creatingChat} aria-busy={creatingChat} aria-label={t('sidebar.newSession')} title={t('sidebar.newSession')} onPointerDown={prefetchSessionDetail}>
                {creatingChat ? <Spinner size={17} /> : <Plus size={19} />}
              </button>
            </ActionDropdownMenu>
          )}
          {/* B-676: 团队 / 自动化 / 待办 / 联系人 / 帮助 — one ⋯ on every device; the badge sums what needs the user. */}
          {top.header.includes('more') && (
            <ActionDropdownMenu
              align="end"
              sideOffset={4}
              items={navEntries.map((e) => ({ key: e.key, label: navMenuLabel(navName[e.key], e.attention), icon: navIcon[e.key], onSelect: () => navigate(e.path) }))}
            >
              <button className="sb-icon-btn sb-more-btn" aria-label={navAttention > 0 ? `${t('sidebar.moreEntries')} · ${navAttention}` : t('sidebar.moreEntries')} title={t('sidebar.moreEntries')}>
                <MoreHorizontal size={18} />
                {navAttention > 0 && <span className="sb-more-attn mono" aria-hidden>{navAttention}</span>}
              </button>
            </ActionDropdownMenu>
          )}
          {/* Collapse only exists in the two-pane desktop layout. On mobile
              (single pane) AppLayout ignores `collapsed` entirely, so this
              button did nothing visible — worse, it silently wrote
              collapsed=1 to localStorage and the NEXT desktop visit opened
              with the sidebar unexpectedly collapsed. Same 980px breakpoint
              as the layout itself, so button and behavior can't disagree. */}
          {top.header.includes('collapse') && (
            <button className="sb-icon-btn" title={t('sidebar.collapse')} aria-label={t('sidebar.collapse')} onClick={toggleCollapsed}>
              <PanelLeftClose size={17} />
            </button>
          )}

        </div>
      </header>

      {/* B-676: two labelled actions instead of a six-row nav column (spec 2026-10-sidebar-header).
          新建会话: the main part starts a chat in one click, ▾ lists every create type. */}
      {top.actions.length > 0 && <div className="sb-actions">
        {top.actions.includes('new-session') && <div className="sb-new-split" ref={newRowRef}>
          <button className="sb-nav-btn sb-new-main" disabled={creatingChat} aria-busy={creatingChat} title={t('sidebar.newSession')} onPointerDown={prefetchSessionDetail} onClick={() => void createChatOrConfigure(navigate, configureNew, { location })}>
            {creatingChat ? <Spinner size={17} /> : <Plus size={17} />}<span>{creatingChat ? (lang.startsWith('zh') ? '正在创建…' : 'Creating…') : t('sidebar.newSession')}</span>
          </button>
          <ActionDropdownMenu align="end" sideOffset={4} contentMinWidth={newRowWidth} items={createItems}>
            <button className="sb-nav-btn sb-new-more" aria-label={t('sidebar.newMenu')} title={t('sidebar.newMenu')} onPointerDown={() => setNewRowWidth(newRowRef.current?.offsetWidth)}>
              <ChevronDown size={14} />
            </button>
          </ActionDropdownMenu>
        </div>}
        {top.actions.includes('new-project') && (
          <button className="sb-nav-btn" title={t('sidebar.newProject')} onClick={() => void createNamedProject()}>
            <FolderPlus size={17} /><span>{t('sidebar.newProject')}</span>
          </button>
        )}
      </div>}

      <div className="sb-list-controls">
      <div className="sb-filter vh-segmented" role="tablist">
        {(['list', 'status', 'archived'] as View[]).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
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

      </div>

      <div className="sb-list-tools">          {orderable && SIDEBAR_RECENT_SORT_ENABLED && (
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
          {(
            <ActionDropdownMenu
              align="end"
              sideOffset={6}
              items={[
                // B-675: 项目 (default) / 标签 / 不分组 — tag grouping is back beside projects.
                { key: 'project', disabled: !orderable, label: `${groupMode === 'project' ? '✓ ' : ''}${t('sidebar.groupProjects')}`, icon: FolderKanban, onSelect: () => selectGroupMode('project') },
                { key: 'tag', disabled: !orderable, label: `${groupMode === 'tag' ? '✓ ' : ''}${t('sidebar.groupTags')}`, icon: Tags, onSelect: () => selectGroupMode('tag') },
                { key: 'none', disabled: !orderable, label: `${groupMode === 'none' ? '✓ ' : ''}${t('sidebar.groupNone')}`, icon: Rows3, onSelect: () => selectGroupMode('none') },
                { key: 'ordering-help', disabled: !orderable || Boolean(teamHistory), label: lang.startsWith('zh') ? '排序说明' : 'Reordering help', icon: CircleHelp, checked: showOrderHint, onSelect: () => setShowOrderHint((shown) => !shown) },
                { key: 'locate-current', disabled: !onRowRoute, label: lang.startsWith('zh') ? '定位当前会话' : 'Locate current session', icon: LocateFixed, separatorBefore: true, onSelect: locateCurrent },
                { key: 'overview', label: `${t('board.title')}${attentionCount ? ` · ${attentionCount}` : ''}`, icon: LayoutGrid, separatorBefore: true, onSelect: () => navigate('/board') },
              ]}
            >
              <button className={`sb-icon-btn${groupMode !== 'none' ? ' is-on' : ''}`} title={t('sidebar.groupMenu')} aria-label={t('sidebar.groupMenu')}>
                {groupMode === 'project' ? <FolderKanban size={17} /> : groupMode === 'tag' ? <Tags size={17} /> : <Rows3 size={17} />}
              </button>
            </ActionDropdownMenu>
          )}

</div></div>
      {showOrderHint && orderable && !teamHistory && <SidebarOrderHint grouped={grouped} onUngroup={() => selectGroupMode('none')} />}

      {tagNoticeVisible && (
        <TagGroupingBackNotice
          onUseTags={() => selectGroupMode('tag')}
          onDismiss={() => setTagNoticeDismissed(true)}
          title={t('sidebar.tagNoticeTitle') as string}
          body={t('sidebar.tagNoticeBody') as string}
          useLabel={t('sidebar.tagNoticeUse') as string}
          dismissLabel={t('sidebar.tagNoticeDismiss') as string}
        />
      )}
      <div className={`sb-list vh-scroll-fade${dragKey ? ' is-dragging' : ''}`} ref={listRef}>
        <PendingSessionRows />
        {/* B-619: invitations first — they need an answer before anything else shows. */}
        <SharedInvites />
        {displayRows === null ? (
          <div className="sb-loading">
            <StatusDot status="thinking" pulse /> {t('common.loading')}
          </div>
        ) : sidebarListEmpty(sections, closedRows.length) ? (
          <div className="sb-empty">{t('sidebar.empty')}</div>
        ) : (
          <>
            {(() => {
              // Flat row index ACROSS sections — must mirror displayRows
              // exactly (⌘1-9 badges + move-up/down read rowsRef positions).
              let flat = 0;
              let peekTipPlaced = false; // B-588: the session-preview tip anchors to the first chat row
              return sections.map((sec) => (
                <div key={sec.id} className="sb-section">
                  {sec.kicker && <div className="sb-section-kicker">{sec.kicker}</div>}
                  {sec.label !== undefined && (
                    <div className={`sb-section-head sb-section-head--toggle${sec.createLocation || sec.makeProject || sec.tagToProject ? ' sb-section-head--workspace' : ''}${sec.project ? ' sb-section-head--project' : ''}`} title={sec.detail || undefined}>
                      {/* B-580: every labelled group folds; Enter/Space via the native button. */}
                      <button
                        type="button"
                        className="sb-section-toggle"
                        aria-expanded={sec.open}
                        onClick={() => {
                          // Only a click on the head persists; it also drops any temporary reveal-open.
                          setRevealExpanded((cur) => { if (!cur.has(sec.id)) return cur; const next = new Set(cur); next.delete(sec.id); return next; });
                          setGroupCollapsed(sec.id, sec.open);
                        }}
                      >
                        <ChevronRight size={11} className={`sb-section-chevron${sec.open ? ' is-open' : ''}`} />
                        {/* B-648: a project's name opens its page; the chevron alone folds it. */}
                        {sec.project ? <span className="sb-visually-hidden">{sec.label}</span> : <span className="sb-section-label">{sec.label}</span>}
                        {!sec.project && <span className="sb-section-count mono">{sec.count}</span>}
                        {!sec.open && !sec.project && <GroupSummary summary={summarizeGroup(sec.allRows.map(rowStatusOf))} zh={lang.startsWith('zh')} />}
                        {/* folded: the summary needs the room; machine · path stays in the head's tooltip */}
                        {sec.detail && sec.open && !sec.project && <span className="sb-section-detail">{sec.detail}</span>}
                      </button>
                      {sec.project && (
                        <button
                          type="button"
                          className={`sb-section-name${location.pathname === `/projects/${encodeURIComponent(sec.project.id)}` ? ' is-selected' : ''}`}
                          aria-current={location.pathname === `/projects/${encodeURIComponent(sec.project.id)}` ? 'page' : undefined}
                          onClick={() => navigate(`/projects/${encodeURIComponent(sec.project!.id)}`)}
                        >
                          <span className="sb-section-label">{sec.label}</span>
                          {sec.attention ? <span className="sb-section-attention" title={t('sidebar.projectAttention', { count: sec.attention }) as string} aria-label={t('sidebar.projectAttention', { count: sec.attention }) as string}>{sec.attention}</span> : null}
                          {!sec.open && <GroupSummary summary={summarizeGroup(sec.allRows.map(rowStatusOf))} zh={lang.startsWith('zh')} />}
                        </button>
                      )}
                      {sec.createLocation && <button
                        type="button" className="sb-workspace-new" disabled={creatingChat}
                        title={lang.startsWith('zh') ? `在此目录新建会话：${sec.createLocation.path}` : `New chat here: ${sec.createLocation.path}`}
                        aria-label={lang.startsWith('zh') ? `在此目录新建会话：${sec.label}` : `New chat here: ${sec.label}`}
                        onPointerDown={prefetchSessionDetail}
                        onClick={() => void createChatOrConfigure(navigate, configureNew, { target: sec.createLocation, ...(sec.project ? { projectId: sec.project.id } : {}) })}
                      ><Plus size={14} /></button>}
                      {sec.makeProject && <button
                        type="button" className="sb-workspace-new sb-workspace-make-project"
                        title={`${t('sidebar.makeProject')}：${sec.makeProject.path}`}
                        aria-label={`${t('sidebar.makeProject')}：${sec.label}`}
                        onClick={() => void makeProjectFrom(sec.makeProject!)}
                      ><FolderPlus size={14} /></button>}
                      {sec.tagToProject && <button
                        type="button" className="sb-workspace-new sb-workspace-make-project"
                        title={t('sidebar.tagToProject', { tag: sec.tagToProject }) as string}
                        aria-label={t('sidebar.tagToProject', { tag: sec.tagToProject }) as string}
                        onClick={() => void convertTagToProject(sec.tagToProject!)}
                      ><FolderPlus size={14} /></button>}
                    </div>
                  )}
                  {sec.rows.map((r) => {
                    // B-619: shared rows are outside displayRows — no ⌘N slot, no reorder.
                    // B-674: the inactive-members fold is a disclosure, not a row — outside displayRows too.
                    const i = r.share || r.teamInactiveFold ? -1 : flat++;
                    if (r.teamInactiveFold) {
                      const fold = r.teamInactiveFold;
                      return <div key={r.key} className="sb-team-child"><button
                        type="button"
                        className="sb-team-archived"
                        aria-expanded={fold.open}
                        title={fold.open ? teamCopy.hideInactive : teamCopy.showInactive}
                        onClick={() => {
                          setRevealExpanded((cur) => { if (!cur.has(r.key)) return cur; const next = new Set(cur); next.delete(r.key); return next; });
                          setGroupCollapsed(r.key, fold.open);
                        }}
                      ><ChevronRight size={13} className={`sb-section-chevron${fold.open ? ' is-open' : ''}`} /><Archive size={14} /><span>{r.title}</span></button></div>;
                    }
                    if (r.team) {
                      const team = r.team;
                      const open = expandedTeams.has(team.id);
                      const selected = location.pathname === r.href;
                      return <div key={r.key} className={`sb-team-row${selected ? ' is-selected' : ''}`}>
                        <button type="button" className="sb-team-toggle" aria-expanded={open} aria-label={`${open ? teamCopy.collapse : teamCopy.expand}: ${team.name}`} onClick={() => setExpandedTeams((current) => { const next = new Set(current); if (open) next.delete(team.id); else next.add(team.id); return next; })}><ChevronRight size={15} className={open ? 'is-open' : ''} /></button>
                        <button type="button" className="sb-team-main" data-href={r.href} aria-current={selected ? 'page' : undefined} onClick={() => navigate(r.href)}>
                          <UsersRound size={17} /><span><strong>{team.name}</strong><small>{team.bots.length ? `${teamMemberCount(team, memberContext)} ${teamCopy.members}` : teamCopy.preparing}</small></span>
                          {cmdHeld && i < 9 && <kbd className="sb-row-badge mono">⌘{i + 1}</kbd>}
                        </button>
                      </div>;
                    }
                    if (r.teamHistoryLink) return <div key={r.key} className="sb-team-child"><div className={`sb-row${location.pathname === r.href ? ' is-selected' : ''}`}>
                      <button type="button" className="sb-row-main" data-href={r.href} aria-current={location.pathname === r.href ? 'page' : undefined} onClick={() => navigate(r.href)}>
                        <span className="sb-row-icon">{r.sessionId ? <History size={16} /> : <UsersRound size={16} />}</span><span className="sb-row-text"><span className="sb-row-title" title={r.subtitle}>{r.teamLabel || r.title}{!r.sessionId && <span className="sb-team-member-status"> · {r.subtitle}</span>}</span>{r.sessionId && <span className="sb-row-sub">{r.subtitle}</span>}</span>
                        {cmdHeld && i < 9 && <kbd className="sb-row-badge mono">⌘{i + 1}</kbd>}
                      </button>
                    </div></div>;
                    const peekTipAnchor = !peekTipPlaced && r.kind === 'session' && !!r.session;
                    if (peekTipAnchor) peekTipPlaced = true;
                    return (
                      <div
                        key={r.key}
                        data-dragkey={r.key}
                        className={`sb-drag-item${r.teamChild ? ' sb-team-child' : ''}${dragKey === r.key ? ' is-drag' : ''}`}
                        onPointerDown={(e) => onRowPointerDown(e, r.key)}
                      >
                        <SidebarRow
                          row={r}
                          execution={executionByKey.get(r.key) ?? (r.session?.presence === 'online' ? 'idle' : 'offline')}
                          backgroundTasks={backgroundCountByKey.get(r.key)}
                          statusNote={legacyStatusKeys.has(r.key) ? t('sidebar.agentStatusLegacy') : undefined}
                          noUpdateSince={noUpdateSinceByKey.get(r.key)}
                          automationAttention={r.kind === 'session' && automationAttentionKeys.has(r.key)}
                          signal={rowSignalOf({
                            attention: attentionKeys.has(r.key),
                            // Sessions: a user-archived session's stale mark
                            // doesn't paint history, but one that merely went
                            // offline after finishing keeps its dot (B-331,
                            // unreadTransition.ts). Terminals carry no such
                            // gate on purpose — see terminalAgentState.ts.
                            unread:
                              (r.kind === 'session' &&
                                showsUnreadDot(r.session, unreadIds)) ||
                              (r.kind === 'terminal' &&
                                !!r.terminalId &&
                                unreadTerminalIds.has(r.terminalId)),
                          })}
                          badge={cmdHeld && i >= 0 && i < 9 ? i + 1 : undefined}
                          canMoveUp={i > 0}
                          canMoveDown={i >= 0 && i < displayRows.length - 1}
                          onMove={orderable && !grouped && !teamHistory && !r.share ? (dir) => moveRow(r.key, i, dir) : undefined}
                          onRenameRequest={() => setRenameTarget(r)}
                          onMoveToProject={projectsSnap.status === 'ready' && r.kind === 'session' && r.sessionId && !r.share && !r.teamHistoryLink
                            ? () => setMoveProjectTarget({ sessionId: r.sessionId!, candidates: sec.allRows.flatMap((x) => (x.kind === 'session' && x.sessionId && !x.share && !x.teamHistoryLink && !x.team ? [{ sessionId: x.sessionId, title: x.title || x.sessionId.slice(0, 8) }] : [])) })
                            : undefined}
                          peekTipAnchor={peekTipAnchor}
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
                      {r.tags && r.tags.length > 0 && (
                        <span className="sb-row-tags">
                          {r.tags.slice(0, 2).map((tag) => (
                            <TagChip key={tag} tag={tag} small />
                          ))}
                          {r.tags.length > 2 && <TagOverflowChip count={r.tags.length - 2} small />}
                        </span>
                      )}
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
                {/* B-265: a daemon that supports restore-terminal brings the
                    terminal back IN PLACE (same id/title/tags, claude resumed).
                    B-149 fallback for older daemons: with a known claude session
                    the action CONTINUES the conversation in a NEW terminal
                    (cwd + `claude --resume`); without one it stays the plain
                    "same directory" open. */}
                <button
                  className="sb-closed-reopen"
                  disabled={!r.machineOnline || !r.cwd || restoringTerminals.has(r.terminalId)}
                  aria-busy={restoringTerminals.has(r.terminalId)}
                  title={t(r.restoreSupported ? 'sidebar.closedTerminalRestore' : r.claudeSessionId ? 'sidebar.closedTerminalResume' : 'sidebar.closedTerminalReopen')}
                  aria-label={t(r.restoreSupported ? 'sidebar.closedTerminalRestore' : r.claudeSessionId ? 'sidebar.closedTerminalResume' : 'sidebar.closedTerminalReopen')}
                  onClick={async () => {
                    if (!r.restoreSupported) {
                      createTerminalAt(navigate, r.machineId, { cwd: r.cwd, resumeClaudeSessionId: r.claudeSessionId });
                      return;
                    }
                    setRestoringTerminals((prev) => new Set(prev).add(r.terminalId));
                    try {
                      await restoreClosedTerminal(navigate, r);
                    } finally {
                      setRestoringTerminals((prev) => {
                        const next = new Set(prev);
                        next.delete(r.terminalId);
                        return next;
                      });
                    }
                  }}
                >
                  {restoringTerminals.has(r.terminalId)
                    ? <Spinner size={14} />
                    : r.restoreSupported || r.claudeSessionId ? <RotateCcw size={16} /> : <Plus size={16} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* B-555: tightest subscription window (renders nothing until reported) */}
      <SidebarRateLimit />
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
        <QuickThemeToggle className="sb-footer-btn sb-footer-icon sb-theme-toggle" />
        {/* Notification center: bell + unread badge + panel (self-contained;
            the collapsed desktop rail carries its own instance). It used to
            sit in the header, which was overflowing as header-right icons
            accumulated — down here it shares the settings row, the other
            "app chrome" affordance. */}
        <NotificationBell className="sb-footer-bell" />
      </footer>

      {showNew && <NewSessionModal initialLocation={newLocation} onClose={() => setShowNew(false)} />}
      {showNewTerminal && <NewTerminalModal onClose={() => setShowNewTerminal(false)} />}
      {showAttachTmux && <AttachTmuxModal onClose={() => setShowAttachTmux(false)} />}
      {showImport && <ImportHistoryModal initialAgent={showImport} onClose={() => setShowImport(null)} />}
      {moveProjectTarget && <MoveToProjectModal initialSessionId={moveProjectTarget.sessionId} candidates={moveProjectTarget.candidates} onClose={() => setMoveProjectTarget(null)} />}
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
function workspaceGroupId(g: { key: string }): string {
  return `workspace:${g.key}`;
}
/** B-675: same ids the pre-B-647 tag lens used, so remembered folds come back too. */
function tagGroupId(g: { tag: string | null }): string {
  return g.tag === null ? 'untagged' : `tag:${g.tag.toLowerCase()}`;
}
/** A labelled group: `rows` empty while folded, `allRows` always complete. */
function collapsibleSection(id: string, label: string, rows: Row[], collapsed: Record<string, boolean>): SidebarSection {
  const open = !isGroupCollapsed(collapsed, id);
  return { id, label, count: rows.length, rows: open ? rows : [], allRows: rows, collapsible: true, open };
}

/** B-580: a folded group's header still shows the states that need the user. */
function GroupSummary({ summary, zh }: { summary: GroupStatusSummary; zh: boolean }) {
  const parts = [
    summary.input ? (zh ? `${summary.input} 个等待操作` : `${summary.input} waiting for you`) : '',
    summary.running ? (zh ? `${summary.running} 个运行中` : `${summary.running} running`) : '',
    summary.unread ? (zh ? `${summary.unread} 个未读` : `${summary.unread} unread`) : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  const label = parts.join(' · ');
  return (
    <span className="sb-section-summary" role="img" aria-label={label} title={label}>
      {summary.input > 0 && <span className="sb-section-summary__item sb-section-summary__item--input"><CircleAlert size={12} />{summary.input}</span>}
      {summary.running > 0 && <span className="sb-section-summary__item"><Spinner size={11} />{summary.running}</span>}
      {summary.unread > 0 && <span className="sb-section-summary__item"><span className="sb-row-unread-dot" />{summary.unread}</span>}
    </span>
  );
}

function rowMenuItems(opts: {
  t: ReturnType<typeof useTranslation>['t'];
  isTerminal: boolean;
  supportsTags: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onRename: () => void;
  onMoveToProject?: () => void;
  onMove?: (dir: -1 | 1) => void;
  onArchiveOrClose: () => void;
  /** B-091/B-522 priority level (null = none); `onSetPriority` undefined hides it on old terminal daemons. */
  priorityLevel?: PriorityLevel | null;
  onSetPriority?: (level: PriorityLevel | null) => void;
  /** B-265/recoverability: inactive session (archived OR offline) → restore in
   *  place (undefined hides it). */
  onRestore?: () => void;
  /** Restore offered but the machine is offline → shown disabled. */
  restoreDisabled?: boolean;
  /** Whether the archive/close lifecycle action shows. Decoupled from restore:
   *  a merely-offline (non-archived) session is BOTH restorable and archivable;
   *  an already-archived one is neither closable nor re-archivable. */
  canArchiveOrClose: boolean;
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
  if (opts.onMoveToProject) items.push({ key: 'move-project', label: t('sidebar.moveToProject'), icon: FolderKanban, onSelect: opts.onMoveToProject });
  if (opts.onRestore) {
    items.push({ key: 'restore', label: t('restore.restore'), icon: RotateCcw, disabled: opts.restoreDisabled, onSelect: opts.onRestore });
  }
  if (opts.onSetPriority) {
    // B-522: P0/P1/P2 as checkable items; the current one unchecks (clears).
    const setPriority = opts.onSetPriority;
    for (const level of PRIORITY_LEVELS) {
      const current = opts.priorityLevel === level;
      items.push({
        key: `priority-${level}`,
        label: t('sidebar.markPriorityLevel', { level: priorityTag(level) }),
        icon: Flag,
        checked: current,
        separatorBefore: level === 0,
        onSelect: () => setPriority(current ? null : level),
      });
    }
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
  // B-265/recoverability: an already-archived session has nothing to archive
  // (restore is its only lifecycle action); a merely-offline non-archived one is
  // still archivable AND restorable, so this is decoupled from onRestore.
  if (opts.canArchiveOrClose) {
    items.push({
      key: 'archive',
      label: opts.isTerminal ? t('common.close') : t('common.archive'),
      icon: opts.isTerminal ? X : Archive,
      danger: !opts.isTerminal,
      separatorBefore: true,
      onSelect: opts.onArchiveOrClose,
    });
  }
  return items;
}

function SidebarRow({
  row,
  execution,
  backgroundTasks,
  statusNote,
  noUpdateSince,
  automationAttention,
  signal,
  badge,
  canMoveUp,
  canMoveDown,
  onMove,
  onRenameRequest,
  onMoveToProject,
  peekTipAnchor,
}: {
  row: Row;
  execution: AgentExecution;
  /** B-507: in-flight background tasks behind a `background` verdict. */
  backgroundTasks?: number;
  /** B-465: appended to the status tooltip when the verdict is an estimate. */
  statusNote?: string;
  /** B-558: start of "no update for N" on unknown (boardItems.noUpdateSince);
   *  undefined → this tab never heard the agent, say "no update" without N. */
  noUpdateSince?: number;
  /** B-508: an automation run waits for the owner's decision about this session. */
  automationAttention?: boolean;
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
  /** B-649: 「移到项目…」 (undefined hides it: projects unavailable, shared or history rows). */
  onMoveToProject?: () => void;
  /** B-588: this row hosts the one-time 「会话预览」 tip */
  peekTipAnchor?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang } = useTranslation();
  // B-588 read-only preview (chat sessions only): fine-pointer hover, the
  // row menu's 「预览」, or Alt+Enter on the focused row.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const peek = useSessionPeek();
  const peekable = row.kind === 'session' && !!row.session;
  useFeatureTipAnchor('session-peek', rowRef, !!peekTipAnchor && peekable, { dismissOnClick: false });
  useEffect(() => {
    if (peek.open) dismissFeatureTip('session-peek');
  }, [peek.open]);

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

  const terminalAgent = useTerminalAgentStates(st => isTerminal && row.terminalId ? st.states[row.terminalId]?.agentKind : undefined);
  const agentLabel = codingAgentLabel(isTerminal ? terminalAgent : s?.metadata?.flavor);
  const status = agentStatusSignal(execution, signal === 'unread');
  // B-587: offline because it hibernated — same slot, a moon instead of the plug.
  const hibernated = !isTerminal && isHibernated(s);
  const now = Date.now();
  // B-558: unknown = the lease expired. Lead with the fact (how long nothing
  // arrived); the estimate note (legacy daemon) already explains itself.
  const unknownLabel = [statusNote ? '' : noUpdateSince !== undefined ? t('sidebar.agentStatusNoUpdate', { duration: fmtDuration(now - noUpdateSince) }) : t('board.noUpdate'), t('sidebar.agentStatusUnknown')].filter(Boolean).join(' · ');
  const availabilityLabel = [execution === 'offline' ? t('sidebar.agentStatusOffline') : execution === 'unknown' ? unknownLabel : '', statusNote ?? ''].filter(Boolean).join(' · ');
  const withNote = (label: string) => [label, statusNote ?? ''].filter(Boolean).join(' · ');
  const statusLabel = status === 'running' ? withNote(t('sidebar.groupRunning'))
    : status === 'background' ? withNote(t('sidebar.rowBackgroundTasks', { count: backgroundTasks ?? 1 }))
    : status === 'input' ? withNote(t('sidebar.rowNeedsAttention'))
    : status === 'unread' ? [t('sidebar.rowUnread'), availabilityLabel].filter(Boolean).join(' · ') : status === 'offline' ? (hibernated ? t('hibernation.rowLabel') : t('sidebar.agentStatusOffline')) : availabilityLabel || t('sidebar.agentStatusUnknown');
  // B-556: the board progress line (report_progress / boardAnalyzer),
  // de-emphasized in words when stale (not running, or >30 min old).
  // Display only — never changes the slot.
  const progress = isTerminal ? null : boardProgressView(s?.metadata?.board, { now, live: execution === 'running' || execution === 'background' || execution === 'input' });
  const progressLabel = progress
    ? [t('sidebar.progressTooltip', { text: progress.text }), progress.stale ? t('sidebar.progressOutdated') : ''].filter(Boolean).join(' · ')
    : '';
  const slotLabel = [status ? statusLabel : '', progressLabel].filter(Boolean).join(' · ');

  const open = () => navigate(row.href);

  // recoverability: an inactive session (archived OR merely offline) is
  // restorable; if its machine is offline the action shows but disabled.
  const restoreMachine = storage((st) => {
    const mid = s?.metadata?.machineId;
    return mid ? st.machines[mid] : undefined;
  });
  const restorable = !isTerminal && canOfferRestore(s, restoreMachine);
  const restoreBlockedOffline = restorable && !restoreMachine?.active;
  const restoreState = useRestoreState(s?.id ?? '');
  const restoring = restoreState?.phase === 'spawning' || restoreState?.phase === 'awaiting-online';
  const onRestore = () => { void restoreSessionOrAlert(s!.id); };
  // Decoupled from restore: a non-archived (incl. merely offline) session can
  // still be archived; an already-archived one cannot.
  const canArchiveOrClose = isTerminal || (!!s && s.archivedAt == null && !s.share);

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

  // B-282: attach terminals get a destructive "close together with the tmux
  // session" item — only when this daemon run declared the capability (an
  // old daemon would silently kill just the web terminal).
  const attachKillMachine = storage((st) => (isTerminal && row.attachTmux && row.machineId ? st.machines[row.machineId] : undefined));
  const canKillAttached = !!row.attachTmux && killAttachedSupported(attachKillMachine?.daemonState);

  // B-619: a shared-with-me row has exactly one action — leave it. Rename,
  // priority, archive and restore all write the OWNER's session.
  const leaveShared = useSessionShares((st) => st.decline);
  const sharedMenuItems: MenuItemDef[] = row.share ? [{
    key: 'leave-shared',
    label: t('sidebar.sharedLeave'),
    icon: X,
    onSelect: () => {
      void (async () => {
        const ok = await Modal.confirm(t('sidebar.sharedLeaveConfirm', { owner: row.share!.owner }), undefined, { confirmText: t('sidebar.sharedLeave'), destructive: true });
        if (!ok) return;
        try {
          await leaveShared(row.share!.grantId);
          sync.onSessionDeleted(row.session!.id);
          if (selected) navigate('/');
        } catch {
          Modal.alert(t('common.error'), t('share.invites.failed'));
        }
      })();
    },
  }] : [];
  // ONE item list feeds both the "…" dropdown and the right-click menu.
  const menuItems = row.share ? sharedMenuItems : rowMenuItems({
    t,
    isTerminal,
    supportsTags: !isTerminal || row.tags !== undefined,
    canMoveUp,
    canMoveDown,
    onRename: onRenameRequest,
    onMoveToProject,
    onMove,
    onArchiveOrClose: () => void onArchiveOrClose(),
    onRestore: restorable ? onRestore : undefined,
    restoreDisabled: restoreBlockedOffline,
    canArchiveOrClose,
    // B-091 标记优先/取消优先 — writes metadata.tags through the same
    // update-metadata op as the rename dialog (setPriorityLevel prepends the
    // tag, so the row also lands in the priority group when grouping is on).
    priorityLevel: priorityLevel(row.tags),
    onSetPriority: isTerminal
      ? row.tags === undefined
        ? undefined
        : (level) =>
            useTerminalSessions
              .getState()
              .update(row.terminalId!, { tags: setPriorityLevel(row.tags, level) })
      : (level) => {
          void sessionUpdateTitleTags(s!.id, { tags: setPriorityLevel(s!.metadata?.tags, level) }).catch(
            () => {},
          );
        },
  });

  // B-586: opt-in sibling of archive for a web-created worktree session (plain
  // archive never deletes). The flow inspects, double-confirms dirty work and
  // keeps the branch (app/worktreeArchive.ts).
  if (!isTerminal && canArchiveAndDeleteWorktree(s ?? undefined, restoreMachine)) {
    menuItems.push({
      key: 'archive-delete-worktree',
      label: worktreeCopy(lang).archiveDelete,
      icon: FolderX,
      danger: true,
      onSelect: () => {
        void archiveAndDeleteWorktree(row.session!).then((archived) => {
          if (archived && selected) navigate(nextSessionPathAfterClose(row.session!.id));
        });
      },
    });
  }

  if (peekable) {
    menuItems.unshift({ key: 'peek', label: t('sessionPeek.preview'), icon: Eye, onSelect: peek.openExplicit });
  }

  if (canKillAttached) {
    menuItems.push({
      key: 'kill-attached',
      label: t('sidebar.closeWithTmuxSession'),
      icon: Trash2,
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        void confirmKillAttachedTerminal(row.machineId!, row.terminalId!, row.attachTmux!, () => {
          if (selected) navigate('/');
        });
      },
    });
  }

  return (
    <ActionContextMenu items={menuItems}>
    <div
      ref={rowRef}
      className={`sb-row${selected ? ' is-selected' : ''}${
        signal === 'attention' ? ' sb-row--attention' : signal === 'unread' ? ' sb-row--unread' : ''
      }`}
      {...(peekable ? { ...peek.rowHandlers, onKeyDown: peek.onKeyDown } : {})}
    >
      {peekable && (
        <SessionPeek
          session={row.session!}
          mode={peek.open}
          onClose={peek.close}
          title={`${row.teamLabel ? `${row.teamLabel} · ` : ''}${row.title}`}
          agentLabel={agentLabel}
          statusLabel={status ? statusLabel : t('sessionPeek.idle')}
          unread={signal === 'unread'}
          anchorRef={rowRef}
        />
      )}
      {/* aria-current="page": the row IS a nav link to the open route, so SRs
          announce the selected row the same way the rail highlight shows it. */}
      <button
        className="sb-row-main"
        title={`${row.title} · ${row.subtitle}`}
        aria-label={`${row.title} · ${row.subtitle}`}
        data-href={row.href}
        onClick={open}
        aria-current={selected ? 'page' : undefined}
        // B-588: the preview is this row's disclosure (menu / Alt+Enter / hover).
        aria-expanded={peekable ? peek.open !== null : undefined}
        aria-describedby={peekable && peek.open !== null ? peekDomId(row.session!.id) : undefined}
      >
        <span className="sb-row-icon sb-row-icon--neutral" title={`${agentLabel} · ${isTerminal ? t('sidebar.kindTerminal') : t('sidebar.kindChat')}`} aria-label={`${agentLabel} · ${isTerminal ? t('sidebar.kindTerminal') : t('sidebar.kindChat')}`}>
          {!isTerminal ? <MessageSquare size={15} /> : terminalAgent === 'claude' ? <Asterisk size={16} /> : terminalAgent === 'codex' ? <CodeXml size={16} /> : terminalAgent === 'pi' ? <Pi size={16} /> : <TerminalSquare size={16} />}
        </span>
        <span className="sb-row-text">
          <span className="sb-row-title-line">
            <span className="sb-row-title">{row.teamLabel ? `${row.teamLabel} · ` : ''}{row.title}</span>
            {/* B-150: this tmux session and its processes are NEW — only the
                directory and the claude conversation carried over. Worth saying
                once, so a fresh scrollback isn't read as lost work. */}
            {row.restored && (
              <span className="sb-row-restored" title={t('sidebar.terminalRestoredHint')}>
                {t('sidebar.terminalRestored')}
              </span>
            )}
            {/* B-486: no tmux on that machine — this shell ends with the
                daemon. Same quiet marker as "restored": context, not alarm. */}
            {row.direct && (
              <span className="sb-row-restored" title={t('sidebar.terminalDirectHint')}>
                {t('sidebar.terminalDirect')}
              </span>
            )}
            {/* B-619: whose session this is (the group header already says it is shared). */}
            {row.share && (
              <span className="sb-row-shared" title={t('sidebar.sharedFrom', { owner: row.share.owner })}>
                <UsersRound size={10} aria-hidden />{row.share.owner}
              </span>
            )}
            {automationAttention && (
              <span className="sb-row-auto-attn" title={t('automations.sessionMarker')} aria-label={t('automations.sessionMarker')} role="img">
                <Zap size={11} />
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
        <span className={`sb-row-status${status ? ` sb-row-status--${status}` : ''}`} title={slotLabel ? `${agentLabel} · ${slotLabel}` : undefined} role={slotLabel ? 'img' : undefined} aria-label={slotLabel ? `${agentLabel} · ${slotLabel}` : undefined}>
          {status === 'running' || status === 'background' ? <Spinner size={14} /> : status === 'input' ? <CircleAlert size={14} />
            : status === 'unknown' ? <UnknownStatus size={13} /> : status === 'offline' ? (hibernated ? <Moon size={13} /> : <Unplug size={13} />)
            : status === 'unread' ? <span className="sb-row-unread-dot" /> : null}
        </span>
        {badge != null && <kbd className="sb-row-badge mono">⌘{badge}</kbd>}
      </button>
      {restorable && (
        <button
          className="sb-closed-reopen"
          title={restoreBlockedOffline ? t('restore.reason.machine-offline') : t('restore.restore')}
          aria-label={t('restore.restore')}
          aria-busy={restoring}
          disabled={restoring || restoreBlockedOffline}
          onClick={(e) => { e.stopPropagation(); onRestore(); }}
        >
          {restoring ? <Spinner size={14} /> : <RotateCcw size={16} />}
        </button>
      )}
      <ActionDropdownMenu items={menuItems} align="end" sideOffset={4}>
        <button className="sb-row-menu" aria-label={t('common.moreActions')} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={16} />
        </button>
      </ActionDropdownMenu>
    </div>
    </ActionContextMenu>
  );
}

/**
 * B-675: one-time notice on devices whose last explicit lens was tag grouping
 * (B-647 had moved them to projects): tag grouping is back, one tap away.
 */
function TagGroupingBackNotice({ onUseTags, onDismiss, title, body, useLabel, dismissLabel }: {
  onUseTags: () => void;
  onDismiss: () => void;
  title: string; body: string; useLabel: string; dismissLabel: string;
}) {
  return (
    <div className="sb-tag-notice" role="status">
      <div className="sb-tag-notice__text"><strong>{title}</strong><span>{body}</span></div>
      <div className="sb-tag-notice__actions">
        <button type="button" className="sb-tag-notice__convert" onClick={onUseTags}>{useLabel}</button>
        <button type="button" className="sb-tag-notice__dismiss" onClick={onDismiss}>{dismissLabel}</button>
      </div>
    </div>
  );
}
