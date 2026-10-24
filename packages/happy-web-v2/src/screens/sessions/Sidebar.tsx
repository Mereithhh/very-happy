import { agentStatusSignal, codingAgentLabel, type AgentExecution } from '@/sync/agentStatus';
import { showsUnreadDot } from '@/sync/unreadTransition';
import type { RecentMachinePath } from '@/utils/quickChat';
import { BrandIcon, BrandEnvBadge } from '@/ui/BrandMark';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { isAppChord } from '@/app/appChord';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Plus, CircleHelp, TerminalSquare, HardDrive, MoreHorizontal, MessageSquare, MessagesSquare, PanelLeftClose, LayoutGrid, SlidersHorizontal, ChevronRight, X, UsersRound, ArrowDownWideNarrow, ListOrdered, FolderOpen, Clock3, Crown, Bot, RotateCcw, Cable, Trash2, History, CircleAlert, CircleHelp as UnknownStatus, Unplug, CodeXml, Asterisk, Pi, Zap, LocateFixed, FolderX, Eye, Moon, FolderKanban, FolderPlus, Tags } from 'lucide-react';
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
import { priorityLevel, setPriorityLevel, sortByPriority } from '@/utils/tags';
import { sidebarListEmpty, visibleSidebarSessions } from './sidebarRows';
import { groupRowsByProject, foldersOfRows, legacyGroupModeFor, resolveSidebarGrouping, showTagGroupingBackNotice, type SidebarGrouping } from './sidebarProjectGroups';
import { buildSidebarTree, entryDepth, listShowsRow, ownerChipResolver, projectDefaultOpen, teamDefaultOpen, teamRowRole, teamsFirst, teamTreeGroupId, treeKeyAction, UNASSIGNED_GROUP_ID } from './sidebarTree';
import { groupRowsByTag } from './sidebarTagGroups';
import { applyLocalMembership, projectsApi, refreshProjects, useProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { MoveToProjectModal } from '@/screens/projects/MoveToProjectModal';
import { NewProjectDialog } from '@/screens/projects/NewProjectDialog';
import type { ProjectView } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';
// aliased: keeps the name apart from lucide's `Settings` gear icon
import type { Settings as SyncedSettings } from '@/sync/settings';
import { TagChip, TagOverflowChip, ActionDropdownMenu, ActionContextMenu, Spinner, type MenuItemDef } from '@/ui';
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
import { useItemNeedsYouSessionIds, useNeedsYouSync, withItemAttention } from '@/sync/needsYou';
import { attentionSessionIds } from '@/screens/automations/automationPresentation';
import { buildSessionMenu, sessionMenuAvailability } from '@/app/sessionMenu';
import { copySessionLink, leaveSessionProject, stopSessionTurn } from '@/app/sessionMenuActions';
import { sessionProjectMenu } from '@/screens/projects/projectChoice';
import { ShareDialog } from '@/screens/session/ShareDialog';
import { isMirrorSession } from '@/assistant/assistantSession';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { resolveTerminalOpenPath } from '@/sync/terminalViewPref';
import { useTeamNavigation } from './useTeamNavigation';
import { botHistorySessionId, groupTeamNavigation, missingTeamSessionIds, teamInactiveGroupId, teamMemberCount, teamMemberInactive, teamSessionMembership, teamSessionSuperseded, unstartedTeamMembers } from './teamNavigation';
import { SidebarTeamRow } from './SidebarTeamRow';
import { newSessionInProject, projectMenuItems } from '@/screens/projects/projectActions';
import { projectMenuCopy, projectNewTeamPath, projectPath, projectSettingsPath } from '@/screens/projects/projectMenu';
import { useTeamNavigationCopy } from './teamNavigationCopy';
import type { TeamBot, TeamState } from '@slopus/happy-wire';
import './sidebar.css';
import { SidebarOrderHint } from './SidebarOrderHint';
import { MajorUpdateEntry } from '@/app/MajorUpdateEntry';
import { sidebarNavEntries, orderCreateMenu, sidebarTopModel, NEW_TEAM_PATH, type SidebarNavKey } from './sidebarNavEntries';
import { SidebarActionRows, SidebarChipRow, SidebarFooter } from './SidebarTop';
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
import { AsciiField } from '@/ui/asciiField/AsciiField';

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
  /** B-759: 「成员由负责人按需创建」 under an expanded team with only its lead (not a nav target, no ⌘N slot). */
  teamEmptyHint?: boolean;
  /** B-762: 「还没有内容。新建会话 或 组建团队」 under an empty project (not a nav row: no ⌘N slot). */
  projectEmptyHint?: ProjectView;
  /** B-762: tree depth in the 按项目 lens (0 = project / 不在项目中 child, 1, 2); undefined in the list lenses. */
  depth?: number;
  /** B-762: the lead or a member of a team — crown / bot icon and the 「负责人」 tag. */
  teamRole?: 'lead' | 'member';
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
  /** B-647: 「设为项目」 for an unassigned folder group. */
  makeProject?: { name: string; machineId: string; path: string; sessionIds: string[] };
  /** B-675: 「转成项目」 for a tag group (the tag→project action kept from B-647). */
  tagToProject?: string;
  /** B-762: the 不在项目中 area head (or 「会话」 for a user without projects). */
  area?: { kind: 'unassigned' | 'chats'; hint: boolean };
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
  const location = useLocation();
  const currentSessionId = /^\/session\/([^/]+)/.exec(location.pathname)?.[1];
  const currentTeamId = currentSessionId ? teamSessionMembership(teams).get(decodeURIComponent(currentSessionId))?.team.id : undefined;
  // B-762: the team page counts as being inside the team (its tree node opens).
  const currentTeamPageId = (() => { const m = /^\/teams\/([^/?]+)/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : undefined; })();
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
  // B-766 W-2: plus sessions with an open 汇报板 item that waits on you (needsYou, Set per session).
  useNeedsYouSync();
  const itemNeedsYou = useItemNeedsYouSessionIds();
  const attentionKeys = useMemo(() => withItemAttention(attentionKeysOf(boardItems), itemNeedsYou), [boardItems, itemNeedsYou]);
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
  // ----- teams (B-480) and the project tree (B-647 → B-762) -----
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
  // B-762 (spec B-760 §5.1): a team node starts folded and opens while its page
  // or one of its conversations is current; a click on its chevron is
  // remembered on this device (`team:<id>`), and opening a member's
  // conversation reveals it for that route even when folded by hand.
  const expandedTeams = useMemo(
    () => new Set(liveTeams.filter((team) => !isGroupCollapsed(collapsedGroups, teamTreeGroupId(team.id), !teamDefaultOpen(team.id === currentTeamId || team.id === currentTeamPageId))).map((team) => team.id)),
    [liveTeams, collapsedGroups, currentTeamId, currentTeamPageId],
  );
  /** Fold / unfold a tree group by hand: persisted, and any temporary reveal-open ends. */
  const toggleTreeGroup = useCallback((id: string, open: boolean) => {
    setRevealExpanded((cur) => { if (!cur.has(id)) return cur; const next = new Set(cur); next.delete(id); return next; });
    setGroupCollapsed(id, open);
  }, []);
  /** Team node + (expanded) member rows in place of the members, ordinary rows untouched; `base` = the group's child depth. */
  const nestTeams = useCallback((groupRows: Row[], groupTeams: TeamState[], base: number): Row[] => {
    if (groupTeams.length === 0) return groupRows.map((r) => ({ ...r, depth: base }));
    const pendingRow = (team: TeamState) => ({bot, task, failed, href}: ReturnType<typeof unstartedTeamMembers>[number]): Row => ({ key: `member:${team.id}:${bot.id}`, kind: 'session', href, title: bot.root ? teamCopy.lead : bot.name, subtitle: failed ? teamCopy.failed : task ? teamCopy.preparing : teamCopy.noSession, ts: team.createdAt, createdAt: team.createdAt, teamHistoryLink: true, depth: base + 1, teamRole: teamRowRole(bot) });
    const unstarted = (team: TeamState, inactive: boolean) => unstartedTeamMembers(team).filter(({ bot }) => (inactiveMembers.unstarted.get(team.id)?.has(bot.id) ?? false) === inactive);
    const fold = {
      // B-729: an earlier generation's conversation folds too, even while the member is active.
      isInactive: (r: Row, team: TeamState, bot: TeamBot | undefined) => !!r.sessionId && (inactiveMembers.sessions.has(r.sessionId) || (!!bot && teamSessionSuperseded(team, bot, r.sessionId))),
      open: inactiveOpenTeams,
      extra: (team: TeamState) => inactiveMembers.unstarted.get(team.id)?.size ?? 0,
    };
    return teamsFirst(groupTeamNavigation(groupRows, groupTeams, expandedTeams, fold)).flatMap((entry): Row[] => {
      const depth = entryDepth(entry, base);
      if (entry.kind === 'inactive') return [
        { key: teamInactiveGroupId(entry.team.id), kind: 'session', href: `/teams/${encodeURIComponent(entry.team.id)}`, title: teamCopy.inactiveCount(entry.count), subtitle: '', ts: 0, createdAt: 0, teamInactiveFold: { teamId: entry.team.id, count: entry.count, open: entry.open }, depth },
        ...(entry.open ? unstarted(entry.team, true).map(pendingRow(entry.team)) : []),
      ];
      if (entry.kind === 'empty') return [{ key: `team-empty:${entry.team.id}`, kind: 'session', href: '', title: teamCopy.membersByLead, subtitle: '', ts: 0, createdAt: 0, teamEmptyHint: true, depth }];
      if (entry.kind === 'row') return [entry.team ? { ...entry.row, depth, teamChild: true, href: `/session/${encodeURIComponent(entry.row.sessionId!)}`, teamLabel: entry.bot?.root ? teamCopy.lead : entry.bot?.name || teamCopy.member, teamRole: teamRowRole(entry.bot) } : { ...entry.row, depth }];
      const header: Row = { key: `team:${entry.team.id}`, kind: 'session', href: `/teams/${encodeURIComponent(entry.team.id)}`, title: entry.team.name, subtitle: '', ts: entry.team.createdAt, createdAt: entry.team.createdAt, team: entry.team, depth };
      const pending: Row[] = expandedTeams.has(entry.team.id) ? unstarted(entry.team, false).map(pendingRow(entry.team)) : [];
      return [header, ...pending];
    });
  }, [expandedTeams, inactiveOpenTeams, inactiveMembers, teamCopy]);
  // 需要你 = waiting for the user or unread — the tree's badges (§5.1), same two signals as the row marker.
  const needsYou = useCallback((r: Row) => attentionKeys.has(r.key)
    || (r.kind === 'session' && showsUnreadDot(r.session, unreadIds))
    || (r.kind === 'terminal' && !!r.terminalId && unreadTerminalIds.has(r.terminalId)), [attentionKeys, unreadIds, unreadTerminalIds]);
  const projectLens = orderable && groupMode === 'project';
  const [unassignedByFolder, setUnassignedByFolder] = useLocalSettingMutable('sidebarUnassignedByFolder');
  const [projectHintDismissed, setProjectHintDismissed] = useLocalSettingMutable('sidebarProjectHintDismissed');
  // B-762: 按项目 is a tree — projects › teams › lead / members, sessions beside
  // the teams, then ONE 不在项目中 area (D2: no folder sub-groups unless asked).
  const tree = useMemo(
    () => (projectLens && orderedRows
      ? buildSidebarTree({ rows: [...orderedRows, ...teamHistoryRows], projects: projectsSnap.projects, members: projectsSnap.members, teams: liveTeams, needsYou })
      : null),
    [projectLens, orderedRows, teamHistoryRows, projectsSnap.projects, projectsSnap.members, liveTeams, needsYou],
  );
  const projectSections = useMemo<SidebarSection[] | null>(() => {
    if (!tree) return null;
    const out: SidebarSection[] = [];
    const currentSession = currentSessionId ? decodeURIComponent(currentSessionId) : undefined;
    const now = Date.now();
    for (const g of tree.projects) {
      const project = g.project!;
      const page = projectPath(project.id);
      const current = location.pathname === page || location.pathname.startsWith(`${page}/`)
        || (!!currentSession && g.rows.some((r) => r.sessionId === currentSession))
        || g.teams.some((team) => team.id === currentTeamPageId);
      const nested = nestTeams(g.rows, g.teams, 1);
      const rows: Row[] = nested.length > 0 ? nested : [{ key: `project-empty:${project.id}`, kind: 'session', href: '', title: '', subtitle: '', ts: 0, createdAt: 0, projectEmptyHint: project, depth: 1 }];
      const primary = project.folders.find((f) => f.primary) ?? project.folders[0];
      out.push({
        ...collapsibleSection(g.id, project.name, rows, collapsedGroups, !projectDefaultOpen({ lastActivity: g.lastActivity, badge: g.badge, current, now })),
        count: g.sessions,
        project,
        attention: g.badge,
        ...(primary ? { createLocation: { machineId: primary.machineId, path: primary.path }, detail: primary.path } : {}),
      });
    }
    const u = tree.unassigned;
    if (!u) return out;
    const hasProjects = tree.projects.length > 0;
    const label = (hasProjects ? t('sidebar.notInProject') : t('sidebar.chatsArea')) as string;
    const area = { kind: hasProjects ? 'unassigned' as const : 'chats' as const, hint: !hasProjects && projectsSnap.status === 'ready' && !projectHintDismissed };
    if (!unassignedByFolder) {
      const rows = nestTeams(u.rows, u.teams, 0);
      // With no project at all the area is the whole list: nothing to fold.
      out.push(hasProjects
        ? { ...collapsibleSection(UNASSIGNED_GROUP_ID, label, rows, collapsedGroups), count: u.sessions, area }
        : { id: UNASSIGNED_GROUP_ID, label, count: u.sessions, rows, allRows: rows, collapsible: false, open: true, area });
      return out;
    }
    // Opt-in (the area's ⋯): the pre-B-762 folder groups, each with 「设为项目」.
    out.push({ id: UNASSIGNED_GROUP_ID, label, count: u.sessions, rows: [], allRows: [], collapsible: false, open: true, area });
    const byFolder = groupRowsByProject(u.rows, [], [], u.teams);
    for (const g of byFolder.unassigned) {
      const sessionIds = g.rows.flatMap((r) => (r.kind === 'session' && r.sessionId && !r.share && !r.teamHistoryLink ? [r.sessionId] : []));
      out.push({
        ...collapsibleSection(workspaceGroupId(g), g.name ?? (t('sidebar.workspaceUnassigned') as string), nestTeams(g.rows, g.teams, 0), collapsedGroups),
        count: g.rows.filter((r) => !r.teamHistoryLink).length,
        detail: [g.machineName, g.path].filter(Boolean).join(' · '),
        createLocation: g.machineId && g.path ? { machineId: g.machineId, path: g.rows.find(r => r.workspacePath)?.workspacePath ?? g.path } : undefined,
        makeProject: projectsSnap.status === 'ready' && g.machineId && g.path && sessionIds.length > 0 ? { name: g.name ?? g.path, machineId: g.machineId, path: g.path, sessionIds } : undefined,
      });
    }
    // B-708: teams with no located row show once, never as one 「无工作目录」 group per history link.
    const tg = byFolder.teamsGroup;
    if (tg) out.push({ ...collapsibleSection('unassigned:teams', teamCopy.title, nestTeams(tg.rows, tg.teams, 0), collapsedGroups), count: tg.rows.filter((r) => !r.teamHistoryLink).length });
    return out;
  }, [tree, nestTeams, collapsedGroups, currentSessionId, currentTeamPageId, location.pathname, unassignedByFolder, projectHintDismissed, projectsSnap.status, teamCopy.title, t]);
  // ----- 按标签 / 最近: session lists (B-762, spec B-760 §5.2) -----
  // No project or team rows; each row names its owner in one chip (team for a
  // lead / member, else project). D3: a member's conversation joins the list
  // only while it waits for the user; the lead's always does.
  const ownerOf = useMemo(() => ownerChipResolver(projectsSnap.projects, projectsSnap.members, liveTeams), [projectsSnap.projects, projectsSnap.members, liveTeams]);
  const listRows = useMemo<Row[] | null>(() => {
    if (!orderable || projectLens || !orderedRows) return null;
    return orderedRows.flatMap((r): Row[] => {
      if (r.kind !== 'session' || r.share) return [r];
      const owner = ownerOf(r.sessionId);
      if (!listShowsRow(owner.role, attentionKeys.has(r.key))) return [];
      return owner.role ? [{ ...r, teamRole: owner.role, teamLabel: owner.role === 'lead' ? teamCopy.lead : owner.botName || teamCopy.member }] : [r];
    });
  }, [orderable, projectLens, orderedRows, ownerOf, attentionKeys, teamCopy.lead, teamCopy.member]);
  // B-675: 按标签 — one group per first tag (priority P0-P2 first, 未分组 last).
  const tagSections = useMemo<SidebarSection[] | null>(() => {
    if (groupMode !== 'tag' || !listRows) return null;
    return groupRowsByTag(listRows).map((g) => ({
      ...collapsibleSection(tagGroupId(g), g.tag ?? (t('sidebar.groupUntagged') as string), g.rows, collapsedGroups),
      ...(g.tag && projectsSnap.status === 'ready' ? { tagToProject: g.tag } : {}),
    }));
  }, [groupMode, listRows, collapsedGroups, projectsSnap.status, t]);
  // Outside the tree a session row names its owner (team or project) in one chip.
  const ownerChipOf = (r: Row) => (!projectLens && r.kind === 'session' && !r.share && !r.teamHistoryLink ? ownerOf(r.sessionId).chip : null);
  // B-762 (D1): the 项目 capability row carries the projects' 需要你 total in every lens.
  const projectBadgeTotal = useMemo(() => {
    if (projectsSnap.status !== 'ready' || !sessions) return 0;
    const live = visibleSidebarSessions(sessions, 'list').filter((s) => !s.share).map(sessionRow);
    return buildSidebarTree({ rows: live, projects: projectsSnap.projects, members: projectsSnap.members, teams: liveTeams, needsYou }).projectBadgeTotal;
  }, [projectsSnap, sessions, liveTeams, needsYou]);
  // B-762: tree members' 运行中 rolls up to their team node.
  const runningTeams = useMemo(() => {
    const out = new Set<string>();
    for (const [sessionId, { team }] of teamSessionMembership(liveTeams)) {
      const e = executionByKey.get(sessionId);
      if (e === 'running' || e === 'background') out.add(team.id);
    }
    return out;
  }, [liveTeams, executionByKey]);
  const groupedSections = projectSections ?? tagSections;
  // Collapsed groups' rows are not rendered, so they take no ⌘1-9 number
  // and no move-up/down position either (B-580). B-762: ⌘1-9 only numbers
  // conversations (lead, members, sessions) — never a team node or a hint.
  const plainDisplayRows = useMemo<Row[] | null>(
    () => (groupedSections ? groupedSections.flatMap((sec) => sec.rows).filter((r) => !r.teamInactiveFold && !r.teamEmptyHint && !r.projectEmptyHint && !r.team) : listRows ?? orderedRows),
    [groupedSections, listRows, orderedRows],
  );
  // B-619: 「分享给我的」 — a trailing group in every view mode; not draggable, no ⌘N badge.
  const sharedRows = useMemo<Row[]>(
    () => (sessions ? sortRowsByRecent(visibleSidebarSessions(sessions, view).filter((s) => !!s.share).map(sessionRow)) : []),
    [sessions, view],
  );
  const displayRows = plainDisplayRows;
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
  const [renameFocusTags, setRenameFocusTags] = useState(false);
  const openRename = useCallback((row: Row, focusTags = false) => { setRenameFocusTags(focusTags); setRenameTarget(row); }, []);
  // B-756: 「分享…」 from a row opens the same share panel as the session header.
  const [shareTarget, setShareTarget] = useState<string | null>(null);
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
          openRename(target);
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
  }, [navigate, openRename]);

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
        rows: displayRows ?? [],
        allRows: displayRows ?? [],
        collapsible: false,
        open: true,
      },
      ...shared,
    ];
  }, [view, statusGroups, completedRows, collapsedGroups, groupedSections, displayRows, sharedRows, t]);

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
  // B-762: a member's conversation opens its team node for this route, even one folded by hand.
  const teamRevealRoute = useRef('');
  useEffect(() => {
    const route = location.pathname;
    if (!currentTeamId || teamRevealRoute.current === route) return;
    teamRevealRoute.current = route;
    const id = teamTreeGroupId(currentTeamId);
    setRevealExpanded((cur) => (cur.has(id) ? cur : new Set([...cur, id])));
  }, [location.pathname, currentTeamId]);
  const locateCurrent = useCallback(() => { revealManual.current = true; setRevealSeq((n) => n + 1); }, []);
  useEffect(() => {
    if (displayRows === null) return;
    const target = findRevealTarget(
      sections.map((sec) => ({ id: sec.id, collapsible: sec.collapsible, keys: sec.allRows })),
      isCurrentRow,
      // B-762: tree projects fold by a live default, so ask the section itself.
      (id) => sections.find((sec) => sec.id === id)?.open === false,
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
  // B-755: 「新建项目」 is a dialog that always asks for a folder (existing or new) and offers the project context.
  const [newProject, setNewProject] = useState<{ name: string; sessionIds: string[] } | null>(null);
  const createNamedProject = useCallback(async () => { setNewProject({ name: '', sessionIds: [] }); }, []);
  /** Project from a set of rows: folders = their machine+path pairs, the first one primary. */
  const makeProjectFromRows = useCallback(async (name: string, sourceRows: Row[]) => {
    const folders = foldersOfRows(sourceRows).map((f, i) => ({ ...f, primary: i === 0 }));
    const sessionIds = sourceRows.flatMap((r) => (r.kind === 'session' && r.sessionId && !r.share ? [r.sessionId] : []));
    // B-755: no folder among the rows → the dialog asks for one instead of a folderless project.
    if (folders.length === 0) { setNewProject({ name, sessionIds }); return; }
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

  // B-713 (spec 2026-10-sidebar-header): no header ⋯. Desktop shows the
  // capability entries as rows while they fit (the rest under 「更多能力 ▾」);
  // the phone gets one chip row 项目 · 团队 · 更多 ▾ under the header.
  const top = sidebarTopModel({ isDesktop, projectsReady: projectsSnap.status === 'ready', teamsVisible: happyBotEntryVisible });
  const navEntries = sidebarNavEntries({ projectsVisible: projectsSnap.status === 'ready', projectAttention: projectBadgeTotal, teamsVisible: happyBotEntryVisible, automationsVisible: automationsEnabled, automationAttention, incomingPeople });
  const navName: Record<SidebarNavKey, string> = {
    projects: lang.startsWith('zh') ? '项目' : 'Projects',
    teams: teamCopy.title,
    automations: t('automations.sidebarEntry'),
    todos: t('todos.title'),
    people: t('people.title'),
  };
  const newTeam = () => navigate(NEW_TEAM_PATH);
  // B-756: 新建会话 into a project — its primary folder, joined before the first message.
  const newProjectSession = (project: ProjectView) => newSessionInProject(project, navigate, configureNew);
  const projectCopy = projectMenuCopy(lang.startsWith('zh'));
  const zh = lang.startsWith('zh');
  const projectItems = (project: ProjectView) => projectMenuItems(project, { zh, navigate, openConfigure: configureNew, teams: happyBotEntryVisible });
  // B-762 (spec B-760 §5.1): the tree's keyboard — ↑/↓ move between nodes, →
  // opens / steps in, ← folds / steps out. Nodes mark their focus target
  // [data-tree-item] and fold button [data-tree-toggle] inside [data-tree-node].
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || isImeGuardedEvent(e.nativeEvent)) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-tree-item]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const nodes = items.map((el) => el.closest<HTMLElement>('[data-tree-node]'));
    const toggles = nodes.map((node) => node?.querySelector<HTMLElement>('[data-tree-toggle]') ?? null);
    const action = treeKeyAction(nodes.map((node, i) => ({ depth: Number(node?.dataset.depth ?? 0), expanded: toggles[i] ? toggles[i]!.getAttribute('aria-expanded') === 'true' : undefined })), index, e.key);
    if (!action) return;
    e.preventDefault();
    if ('focus' in action) items[action.focus].focus();
    else toggles[action.toggle]?.click();
  };


  return (
    <div className="sb">
      {/* B-720: a barely-there ASCII field behind the footer / list tail. First
          child + positioned rows after it = painted under every row, no new
          stacking context (inline modals here keep their z-index). */}
      <div className="sb-ascii"><AsciiField preset="sidebar" /></div>
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

      {/* B-676/B-713: labelled 新建会话 ▾ / 新建项目 / 新建团队 rows, then the capability rows (spec 2026-10-sidebar-header).
          新建会话: the main part starts a chat in one click, ▾ lists every create type. */}
      <SidebarActionRows
        actions={top.actions}
        creatingChat={creatingChat}
        createItems={createItems}
        capabilities={navEntries}
        capabilityNames={navName}
        listRef={listRef}
        onNewChat={() => void createChatOrConfigure(navigate, configureNew, { location })}
        onNewProject={() => void createNamedProject()}
        onNewTeam={newTeam}
        onNavigate={navigate}
      />
      <SidebarChipRow
        chips={top.chips}
        capabilities={navEntries}
        capabilityNames={navName}
        onNavigate={navigate}
      />

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
                // B-675: 项目 (default) / 标签 / 不分组. B-762 (spec B-760 §5.2): one structure
                // view and two lists — 按项目（结构） / 按标签 / 最近 (不分组 renamed).
                { key: 'project', disabled: !orderable, label: `${groupMode === 'project' ? '✓ ' : ''}${t('sidebar.groupProjects')}`, icon: FolderKanban, onSelect: () => selectGroupMode('project') },
                { key: 'tag', disabled: !orderable, label: `${groupMode === 'tag' ? '✓ ' : ''}${t('sidebar.groupTags')}`, icon: Tags, onSelect: () => selectGroupMode('tag') },
                { key: 'none', disabled: !orderable, label: `${groupMode === 'none' ? '✓ ' : ''}${t('sidebar.groupNone')}`, icon: Clock3, onSelect: () => selectGroupMode('none') },
                { key: 'ordering-help', disabled: !orderable, label: lang.startsWith('zh') ? '排序说明' : 'Reordering help', icon: CircleHelp, checked: showOrderHint, onSelect: () => setShowOrderHint((shown) => !shown) },
                { key: 'locate-current', disabled: !onRowRoute, label: lang.startsWith('zh') ? '定位当前会话' : 'Locate current session', icon: LocateFixed, separatorBefore: true, onSelect: locateCurrent },
                { key: 'overview', label: `${t('board.title')}${attentionCount ? ` · ${attentionCount}` : ''}`, icon: LayoutGrid, separatorBefore: true, onSelect: () => navigate('/board') },
              ]}
            >
              <button className="sb-lens-btn" title={t('sidebar.groupMenu')} aria-label={`${t('sidebar.groupMenu')}: ${t(groupMode === 'project' ? 'sidebar.lensProjects' : groupMode === 'tag' ? 'sidebar.lensTags' : 'sidebar.lensRecent')}`}>
                {groupMode === 'project' ? <FolderKanban size={15} /> : groupMode === 'tag' ? <Tags size={15} /> : <Clock3 size={15} />}
                <span>{t(groupMode === 'project' ? 'sidebar.lensProjects' : groupMode === 'tag' ? 'sidebar.lensTags' : 'sidebar.lensRecent')}</span>
              </button>
            </ActionDropdownMenu>
          )}

</div></div>
      {showOrderHint && orderable && <SidebarOrderHint grouped={grouped} onUngroup={() => selectGroupMode('none')} />}

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
      <div className={`sb-list vh-scroll-fade${dragKey ? ' is-dragging' : ''}${projectLens ? ' sb-list--tree' : ''}`} ref={listRef} onKeyDown={projectLens ? onTreeKeyDown : undefined}>
        <PendingSessionRows />
        {/* B-619: invitations first — they need an answer before anything else shows. */}
        <SharedInvites />
        {displayRows === null ? (
          <div className="sb-loading">
            <Spinner size={12} /> {t('common.loading')}
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
                <div key={sec.id} className={`sb-section${sec.project ? ' sb-section--project' : ''}${sec.area ? ' sb-section--area' : ''}`}>
                  {/* B-762 (spec B-760 §5.1): a project is the tree's level-1 node — chevron (fold) ·
                      FolderKanban · name (opens the project) · 需要你 badge or session count; hover ＋ / ⋯,
                      right-click / long-press = the project menu (a bottom sheet on touch). */}
                  {sec.project && (() => {
                    const project = sec.project;
                    const selected = location.pathname === projectPath(project.id) || location.pathname === projectSettingsPath(project.id);
                    return (
                      <ActionContextMenu items={projectItems(project)} sheetTitle={project.name}>
                        <div className="sb-tree-node" data-tree-node data-depth={0} style={{ '--depth': 0 } as React.CSSProperties}>
                          <div className={`sb-tree-project${selected ? ' is-selected' : ''}`} title={sec.detail || undefined}>
                            <button type="button" className="sb-tree-chevron" data-tree-toggle tabIndex={-1} aria-expanded={sec.open}
                              aria-label={t(sec.open ? 'sidebar.treeCollapse' : 'sidebar.treeExpand', { name: project.name }) as string}
                              onClick={() => toggleTreeGroup(sec.id, sec.open)}
                            ><ChevronRight size={13} className={sec.open ? 'is-open' : ''} /></button>
                            <button type="button" className="sb-tree-project-main" data-tree-item aria-current={selected ? 'page' : undefined} onClick={() => navigate(projectPath(project.id))}>
                              <FolderKanban size={16} aria-hidden />
                              <span className="sb-tree-project-name">{sec.label}</span>
                              {sec.attention
                                ? <span className="sb-tree-badge" role="img" title={t('sidebar.treeAttention', { count: sec.attention }) as string} aria-label={t('sidebar.treeAttention', { count: sec.attention }) as string}>{sec.attention}</span>
                                : <span className="sb-tree-count mono">{sec.count}</span>}
                            </button>
                            <span className="sb-tree-project-acts">
                            <button
                              type="button" className="sb-project-act" disabled={creatingChat}
                              title={`${projectCopy.newSession}：${sec.label}`}
                              aria-label={`${projectCopy.newSession}: ${sec.label}`}
                              onPointerDown={prefetchSessionDetail}
                              onClick={() => newProjectSession(project)}
                            ><Plus size={14} /></button>
                            <ActionDropdownMenu items={projectItems(project)} align="end" sideOffset={4} sheetTitle={project.name}>
                              <button type="button" className="sb-project-act" title={projectCopy.actions} aria-label={`${projectCopy.actions}: ${sec.label}`}><MoreHorizontal size={14} /></button>
                            </ActionDropdownMenu>
                            </span>
                          </div>
                        </div>
                      </ActionContextMenu>
                    );
                  })()}
                  {/* B-762: 不在项目中 — small title + hairline (D2: flat; folder groups from its ⋯).
                      With no project yet it is just 「会话」 plus a dismissible hint. */}
                  {sec.area && (
                    <>
                      <div className="sb-tree-area" data-tree-node data-depth={-1}>
                        {sec.collapsible ? (
                          <button type="button" className="sb-tree-area-toggle" data-tree-item data-tree-toggle aria-expanded={sec.open} onClick={() => toggleTreeGroup(sec.id, sec.open)}>
                            <ChevronRight size={11} className={`sb-section-chevron${sec.open ? ' is-open' : ''}`} />
                            <span>{sec.label}</span><span className="mono">{sec.count}</span>
                          </button>
                        ) : <span className="sb-tree-area-label">{sec.label}</span>}
                        <span className="sb-tree-area-rule" aria-hidden />
                        {sec.area.kind === 'unassigned' && (
                          <ActionDropdownMenu align="end" sideOffset={4} items={[
                            { key: 'by-folder', label: t('sidebar.groupUnassignedByFolder'), icon: FolderOpen, checked: !!unassignedByFolder, onSelect: () => setUnassignedByFolder(!unassignedByFolder) },
                          ]}>
                            <button type="button" className="sb-tree-area-menu" title={t('sidebar.unassignedActions')} aria-label={t('sidebar.unassignedActions')}><MoreHorizontal size={14} /></button>
                          </ActionDropdownMenu>
                        )}
                      </div>
                      {sec.area.hint && sec.allRows.length > 0 && (
                        <p className="sb-tree-hint">
                          {t('sidebar.projectHint')}{' '}
                          <button type="button" className="sb-tree-link" onClick={() => void createNamedProject()}>{t('sidebar.newProject')}</button>
                          <button type="button" className="sb-tree-hint-close" title={t('sidebar.projectHintDismiss')} aria-label={t('sidebar.projectHintDismiss')} onClick={() => setProjectHintDismissed(true)}><X size={12} /></button>
                        </p>
                      )}
                    </>
                  )}
                  {sec.label !== undefined && !sec.project && !sec.area && (
                    <div className={`sb-section-head sb-section-head--toggle${sec.createLocation || sec.makeProject || sec.tagToProject ? ' sb-section-head--workspace' : ''}`} title={sec.detail || undefined}>
                      {/* B-580: every labelled group folds; Enter/Space via the native button. */}
                      <button
                        type="button"
                        className="sb-section-toggle"
                        aria-expanded={sec.open}
                        onClick={() => toggleTreeGroup(sec.id, sec.open)}
                      >
                        <ChevronRight size={11} className={`sb-section-chevron${sec.open ? ' is-open' : ''}`} />
                        <span className="sb-section-label">{sec.label}</span>
                        <span className="sb-section-count mono">{sec.count}</span>
                        {!sec.open && <GroupSummary summary={summarizeGroup(sec.allRows.map(rowStatusOf))} zh={zh} />}
                        {/* folded: the summary needs the room; machine · path stays in the head's tooltip */}
                        {sec.detail && sec.open && <span className="sb-section-detail">{sec.detail}</span>}
                      </button>
                      {sec.createLocation && <button
                        type="button" className="sb-workspace-new" disabled={creatingChat}
                        title={zh ? `在此目录新建会话：${sec.createLocation.path}` : `New chat here: ${sec.createLocation.path}`}
                        aria-label={zh ? `在此目录新建会话：${sec.label}` : `New chat here: ${sec.label}`}
                        onPointerDown={prefetchSessionDetail}
                        onClick={() => void createChatOrConfigure(navigate, configureNew, { target: sec.createLocation })}
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
                    // B-762: so are tree hints and team nodes (⌘1-9 numbers conversations only).
                    const i = r.share || r.teamInactiveFold || r.teamEmptyHint || r.projectEmptyHint || r.team ? -1 : flat++;
                    // B-762: every tree node carries its depth (indent + guide lines, sidebar.css).
                    const treeNode = r.depth !== undefined ? { 'data-tree-node': '', 'data-depth': r.depth, style: { '--depth': r.depth } as React.CSSProperties } : null;
                    if (r.projectEmptyHint) {
                      const project = r.projectEmptyHint;
                      return <div key={r.key} className="sb-tree-node" {...treeNode}><p className="sb-tree-empty">
                        {t('sidebar.projectEmpty')}{' '}
                        <button type="button" className="sb-tree-link" disabled={creatingChat} onClick={() => newProjectSession(project)}>{projectCopy.newSession}</button>
                        {happyBotEntryVisible && <> {t('sidebar.projectEmptyOr')} <button type="button" className="sb-tree-link" onClick={() => navigate(projectNewTeamPath(project.id))}>{t('sidebar.startTeam')}</button></>}
                      </p></div>;
                    }
                    if (r.teamEmptyHint) return <div key={r.key} className="sb-tree-node" {...treeNode}><p className="sb-team-empty">{r.title}</p></div>;
                    if (r.teamInactiveFold) {
                      const fold = r.teamInactiveFold;
                      return <div key={r.key} className="sb-tree-node" {...treeNode}><button
                        type="button"
                        className="sb-team-archived"
                        data-tree-item
                        data-tree-toggle
                        aria-expanded={fold.open}
                        title={fold.open ? teamCopy.hideInactive : teamCopy.showInactive}
                        onClick={() => toggleTreeGroup(r.key, fold.open)}
                      ><ChevronRight size={13} className={`sb-section-chevron${fold.open ? ' is-open' : ''}`} /><span>{r.title}</span></button></div>;
                    }
                    if (r.team) {
                      // B-759: row → team page, chevron → fold only, lead → its own member row / the context menu.
                      const team = r.team;
                      const open = expandedTeams.has(team.id);
                      const attention = tree?.teamBadges.get(team.id) ?? 0;
                      const unplaced = (tree?.projects.length ?? 0) > 0 && !projectsSnap.projects.some((p) => !p.archivedAt && (p.teamIds ?? []).includes(team.id));
                      return <SidebarTeamRow
                        key={r.key}
                        team={team}
                        open={open}
                        pathname={location.pathname}
                        depth={r.depth ?? 0}
                        attention={attention}
                        attentionLabel={t('sidebar.treeAttention', { count: attention }) as string}
                        countLabel={team.bots.length ? teamCopy.headcount(teamMemberCount(team, memberContext)) : teamCopy.preparing}
                        running={runningTeams.has(team.id)}
                        unplacedLabel={unplaced ? teamCopy.unplaced : undefined}
                        copy={teamCopy}
                        onToggle={() => toggleTreeGroup(teamTreeGroupId(team.id), open)}
                        onNavigate={navigate}
                      />;
                    }
                    if (r.teamHistoryLink) return <div key={r.key} className="sb-tree-node" {...treeNode}><div className={`sb-row${location.pathname === r.href ? ' is-selected' : ''}`}>
                      <button type="button" className="sb-row-main" data-tree-item data-href={r.href} aria-current={location.pathname === r.href ? 'page' : undefined} onClick={() => navigate(r.href)}>
                        <span className="sb-row-icon">{r.sessionId ? <History size={14} /> : r.teamRole === 'lead' ? <Crown size={14} /> : <Bot size={14} />}</span><span className="sb-row-text"><span className="sb-row-title" title={r.subtitle}>{r.teamLabel || r.title}<span className="sb-team-member-status"> · {r.subtitle}</span></span></span>
                        {cmdHeld && i < 9 && <kbd className="sb-row-badge mono">⌘{i + 1}</kbd>}
                      </button>
                    </div></div>;
                    const peekTipAnchor = !peekTipPlaced && r.kind === 'session' && !!r.session;
                    if (peekTipAnchor) peekTipPlaced = true;
                    return (
                      <div
                        key={r.key}
                        data-dragkey={r.key}
                        className={`sb-drag-item${treeNode ? ' sb-tree-node' : ''}${dragKey === r.key ? ' is-drag' : ''}`}
                        {...treeNode}
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
                          onMove={orderable && !grouped && !r.share ? (dir) => moveRow(r.key, i, dir) : undefined}
                          onRenameRequest={(focusTags) => openRename(r, focusTags)}
                          projectMenu={r.kind === 'session' && r.sessionId && !r.share && !r.teamHistoryLink ? sessionProjectMenu(r.sessionId, projectsSnap, { shared: false, zh: lang.startsWith('zh') }) : undefined}
                          onMoveToProject={projectsSnap.status === 'ready' && r.kind === 'session' && r.sessionId && !r.share && !r.teamHistoryLink
                            ? () => setMoveProjectTarget({ sessionId: r.sessionId!, candidates: sec.allRows.flatMap((x) => (x.kind === 'session' && x.sessionId && !x.share && !x.teamHistoryLink && !x.team ? [{ sessionId: x.sessionId, title: x.title || x.sessionId.slice(0, 8) }] : [])) })
                            : undefined}
                          onShare={r.kind === 'session' && r.session ? () => setShareTarget(r.session!.id) : undefined}
                          ownerChip={ownerChipOf(r)}
                          hideFirstTag={groupMode === 'tag' && orderable && !!r.tags?.[0]}
                          sheetTitle={treeNode ? r.title : undefined}
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
      {/* B-715: unread big updates — persistent entry above the footer (B-713 owns the footer row). */}
      <MajorUpdateEntry />
      <SidebarFooter onSettings={() => navigate('/settings')} onHelp={() => navigate('/help')} onToggleNotes={toggleNotesPanel} />

      {showNew && <NewSessionModal initialLocation={newLocation} onClose={() => setShowNew(false)} />}
      {showNewTerminal && <NewTerminalModal onClose={() => setShowNewTerminal(false)} />}
      {showAttachTmux && <AttachTmuxModal onClose={() => setShowAttachTmux(false)} />}
      {showImport && <ImportHistoryModal initialAgent={showImport} onClose={() => setShowImport(null)} />}
      {newProject && <NewProjectDialog initialName={newProject.name} sessionIds={newProject.sessionIds} onClose={() => setNewProject(null)} />}
      {shareTarget && <ShareDialog key={`share:${shareTarget}`} sessionId={shareTarget} open onOpenChange={(open) => { if (!open) setShareTarget(null); }} />}
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
          focusTags={renameFocusTags}
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

function workspaceGroupId(g: { key: string }): string {
  return `workspace:${g.key}`;
}
/** B-675: same ids the pre-B-647 tag lens used, so remembered folds come back too. */
function tagGroupId(g: { tag: string | null }): string {
  return g.tag === null ? 'untagged' : `tag:${g.tag.toLowerCase()}`;
}
/** A labelled group: `rows` empty while folded, `allRows` always complete. */
function collapsibleSection(id: string, label: string, rows: Row[], collapsed: Record<string, boolean>, fallbackCollapsed?: boolean): SidebarSection {
  const open = !isGroupCollapsed(collapsed, id, fallbackCollapsed);
  return { id, label, count: rows.filter((r) => !r.teamEmptyHint).length, rows: open ? rows : [], allRows: rows, collapsible: true, open };
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
  projectMenu,
  onMoveToProject,
  onShare,
  ownerChip,
  sheetTitle,
  hideFirstTag,
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
  onRenameRequest: (focusTags?: boolean) => void;
  /** B-756: this session's project entries (`sessionProjectMenu`), undefined for terminals / shared / history rows. */
  projectMenu?: ReturnType<typeof sessionProjectMenu>;
  /** B-649: 「移到项目…」 (undefined hides it: projects unavailable, shared or history rows). */
  onMoveToProject?: () => void;
  /** B-756: 「分享…」 — the session header's share panel (owner's active sessions only). */
  onShare?: () => void;
  /** B-762 (spec B-760 §5.2): ONE owner chip outside the tree — the team for a lead / member, else the project. */
  ownerChip?: { kind: 'team' | 'project'; name: string } | null;
  /** B-762: a tree row's long-press menu is a bottom sheet on touch, headed by this. */
  sheetTitle?: string;
  /** B-762: 按标签 — the group head already names the first tag, so the row leaves room for its owner chip. */
  hideFirstTag?: boolean;
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
  const shownTags = (hideFirstTag ? row.tags?.slice(1) : row.tags) ?? [];
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
  // ONE item list feeds both the "…" dropdown and the right-click menu, built
  // by the same function as the session header ⋯ (B-756, app/sessionMenu.ts).
  const zh = lang.startsWith('zh');
  const leave = projectMenu?.leave;
  // Same gate as the session header ⋯ (terminals: rename / tags / priority / close as before).
  const avail = s ? sessionMenuAvailability(s, { running: execution === 'running' || execution === 'background', mirror: isMirrorSession(s) }) : null;
  const menuItems = row.share ? [...sharedMenuItems, ...buildSessionMenu({ t, zh, onCopyLink: () => void copySessionLink(row.href, zh) })] : buildSessionMenu({
    t,
    zh,
    isTerminal,
    onShare: avail?.share ? onShare : undefined,
    onRename: () => onRenameRequest(false),
    onTags: !isTerminal || row.tags !== undefined ? () => onRenameRequest(true) : undefined,
    project: projectMenu,
    onMoveToProject,
    onLeaveProject: leave && s ? () => void leaveSessionProject(leave.projectId, s.id, zh) : undefined,
    // B-091 标记优先/取消优先 — writes metadata.tags through the same
    // update-metadata op as the rename dialog (setPriorityLevel prepends the
    // tag, so the row also lands in the priority group when grouping is on).
    priority: isTerminal && row.tags === undefined ? undefined : {
      level: priorityLevel(row.tags),
      onSet: isTerminal
        ? (level) => useTerminalSessions.getState().update(row.terminalId!, { tags: setPriorityLevel(row.tags, level) })
        : (level) => { void sessionUpdateTitleTags(s!.id, { tags: setPriorityLevel(s!.metadata?.tags, level) }).catch(() => {}); },
    },
    onCopyLink: () => void copySessionLink(row.href, zh),
    restore: restorable ? { onSelect: onRestore, disabled: restoreBlockedOffline } : undefined,
    // Full-list adjacent swap — the reorder path for coarse pointers (no touch drag).
    reorder: onMove ? { canUp: !!canMoveUp, canDown: !!canMoveDown, onMove } : undefined,
    onStop: !isTerminal && s && avail?.stop ? () => void stopSessionTurn(s.id, t('session.chat.stopFailed')) : undefined,
    onArchive: isTerminal || avail?.archive ? () => void onArchiveOrClose() : undefined,
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
    <ActionContextMenu items={menuItems} sheetTitle={sheetTitle}>
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
        data-tree-item
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
          {row.teamRole === 'lead' ? <Crown size={14} /> : row.teamRole === 'member' ? <Bot size={14} /> : !isTerminal ? <MessageSquare size={15} /> : terminalAgent === 'claude' ? <Asterisk size={16} /> : terminalAgent === 'codex' ? <CodeXml size={16} /> : terminalAgent === 'pi' ? <Pi size={16} /> : <TerminalSquare size={16} />}
        </span>
        <span className="sb-row-text">
          <span className={`sb-row-title-line${row.teamRole ? ' sb-row-title-line--team' : ''}`}>
            {/* B-762: the lead carries a 「负责人」 tag; a member reads 「名字 · 任务」 with the task faint.
                B-773: the tag is a fixed prefix BESIDE the title box — inside it, the tag ate the
                ellipsis box and left the title 0px. */}
            {row.teamRole === 'lead'
              ? <><span className="sb-lead-tag">{row.teamLabel}</span><span className="sb-row-title">{row.title}</span></>
              : row.teamRole === 'member'
                ? <span className="sb-row-title">{row.teamLabel}<span className="sb-row-task"> · {row.title}</span></span>
                : <span className="sb-row-title">{row.teamLabel ? `${row.teamLabel} · ` : ''}{row.title}</span>}
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
            {/* B-756/B-762: the one owner chip — team or project (tag / recent / status views). */}
            {ownerChip && (
              <span className="sb-row-project" title={ownerChip.name}>
                {ownerChip.kind === 'team' ? <UsersRound size={10} aria-hidden /> : <FolderKanban size={10} aria-hidden />}<span className="sb-row-project-name">{ownerChip.name}</span>
              </span>
            )}
            {automationAttention && (
              <span className="sb-row-auto-attn" title={t('automations.sessionMarker')} aria-label={t('automations.sessionMarker')} role="img">
                <Zap size={11} />
              </span>
            )}
            {shownTags.length > 0 && (
              <span className="sb-row-tags">
                {shownTags.slice(0, 2).map((tag) => (
                  <TagChip key={tag} tag={tag} small />
                ))}
                {shownTags.length > 2 && <TagOverflowChip count={shownTags.length - 2} small />}
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
      <ActionDropdownMenu items={menuItems} align="end" sideOffset={4} sheetTitle={sheetTitle}>
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
