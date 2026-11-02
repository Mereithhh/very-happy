import type { RecentMachinePath } from '@/utils/quickChat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IS_MAC, isAppChord } from '@/app/appChord';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search,
  Plus,
  Settings,
  TerminalSquare,
  MessageSquare,
  Pencil,
  Archive,
  ClipboardList,
  StickyNote,
  UsersRound,
  ListChecks,
  FolderOpen,
  RotateCcw,
  History,
  HardDrive,
  MessageSquarePlus,
  Download,
  X,
} from 'lucide-react';
import { useSessions, storage, useLocalSetting } from '@/sync/storage';
import { Combobox, SelectMenu } from '@/ui';
import { machineLabel } from '@/utils/machineUtils';
import { splitHighlights } from '@/screens/sessions/historySearch';
import type { HistoryAgent } from '@/screens/sessions/claudeHistoryImport';
import { formatSessionAge } from '@/screens/sessions/newTerminalAttach';
import { requestChatJump } from '@/screens/search/chatJump';
import { pickerOwnsKey } from '@/screens/search/pickerOwnsKey';
import { useSessionSearch } from '@/screens/search/useSessionSearch';
import {
  matchSessionSearchChord,
  type Range,
  type ResultSnippet,
  type SessionSearchFilters,
  type SessionSearchRow,
  type StatusFilter,
  type TimeFilter,
} from '@/screens/search/sessionSearch';
import { isHiddenSession } from '@/assistant/assistantSession';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { getSessionName, getSessionSubtitle, formatLastSeen } from '@/utils/sessionUtils';
import { useBoardItems } from '@/screens/board/useBoardItems';
import { createTerminalOrPick, NEW_TERMINAL_SHORTCUT_HINT } from '@/app/newTerminal';
import { createChatOrConfigure } from '@/app/newChat';
import { sessionUpdateTitle } from '@/sync/ops';
import { archiveSessionNow, nextSessionPathAfterClose, restoreSessionOrAlert } from '@/app/rowActions';
import { canOfferRestore } from '@/app/sessionRestore';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { NewSessionModal } from '@/screens/sessions/NewSessionModal';
import { NewTerminalModal } from '@/screens/sessions/NewTerminalModal';
import { AttachTmuxModal } from '@/screens/sessions/AttachTmuxModal';
import { ImportHistoryModal, type ImportHistoryAgent } from '@/screens/sessions/ImportHistoryModal';
import { openClipboardHistory } from '@/screens/clipboard/ClipboardHistoryPanel';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { FileSearch } from 'lucide-react';
import { onQuickOpen, openQuickOpen } from '@/screens/quickopen/quickOpenEvents';
import type { AgentExecution } from '@/sync/agentStatus';
import {
  boardItemExecution,
  filterPaletteItems,
  freezeNeedsYouKeys,
  moveActive,
  resolveActiveIndex,
  type PaletteActive,
  newChatDraftFor,
  orderPaletteItems,
  resolveFrozenRows,
  selectNeedsYouSessions,
  paletteSettingsQuery,
  PALETTE_SETTINGS_LIMIT,
  type PaletteGroup,
  contentSearchText,
  PALETTE_DEFAULT_FILTERS,
  splitSearchRows,
  paletteFiltersActive,
  PALETTE_GROUP_ORDER,
  adoptFirstResult,
  CREATE_ROW_KEY,
} from './paletteModel';
import { parseSidebarQuery } from '@/screens/sessions/sidebarSearch';
import { isWebPushSupported } from '@/sync/webPush';
import { getNotificationPermission } from '@/sync/webNotifications';
import { PaletteStatusMark } from './PaletteStatusMark';
import { listArrowDelta } from '@/utils/listArrowKey';
import { COMMAND_PALETTE_OPEN_EVENT, COMMAND_PALETTE_HINT, SESSION_SEARCH_HINT } from '@/screens/search/sessionSearchEvents';
import './commandpalette.css';
import { OVERLAY_PRIORITY, useOverlayTurn } from '@/app/overlayQueue';

/**
 * Programmatic open — the palette owns its open state; UI entry points that
 * can't press ⌘K (the sidebar 🔍, the release-notes action) dispatch this
 * event instead. Window event, not a store: the palette is a singleton and
 * nothing else needs to observe the state.
 *
 * B-865: the palette is THE search entry — ⌘K, ⌘⇧F and the sidebar 🔍 all open
 * it; the old separate session-search panel (B-650) lives on as its 「对话内容」
 * group and filter bar.
 */
const OPEN_EVENT = COMMAND_PALETTE_OPEN_EVENT;
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

type CommandItem = {
  key: string;
  group: PaletteGroup;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  /** lower-cased haystack for substring matching */
  haystack: string;
  /** chat/terminal tags — `#tag` query terms filter on these (sidebar grammar) */
  tags?: string[];
  /** optional keyboard-shortcut hint rendered on the row's right edge */
  hint?: string;
  /** B-552 等我看 rows: the sidebar's status mark + "how long ago" */
  status?: { execution: AgentExecution; unread: boolean; backgroundTasks?: number; flavor?: string | null; legacy?: boolean; at: number };
  /** B-865: highlighted title (content rows) */
  titleRanges?: Range[];
  subtitleRanges?: Range[];
  /** B-865: what was said — each snippet opens the session on that hit */
  snippets?: ResultSnippet[];
  openSnippet?: (snippet: ResultSnippet) => void;
  badge?: 'archived' | 'importable';
  /** B-865: content rows show their age like the old search panel */
  updatedAt?: number;
  run: () => void | Promise<void>;
};

/** Dialogs live in the always-mounted shell: they outlive the panel, which
 *  unmounts the moment an item runs. */
type PaletteDialogs = {
  newChat: (target?: RecentMachinePath, draft?: string) => void;
  newTerminalAt: () => void;
  attachTmux: () => void;
  importHistory: (agent: ImportHistoryAgent) => void;
  searchHistory: () => void;
  /** B-865 (was B-650): an importable content hit → that machine's history search */
  importFound: (target: { machineId: string; agent: HistoryAgent; query: string }) => void;
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [newChatDialog, setNewChatDialog] = useState<{ target?: RecentMachinePath; draft?: string } | null>(null);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [showAttachTmux, setShowAttachTmux] = useState(false);
  const [showImport, setShowImport] = useState<ImportHistoryAgent | null>(null);
  // B-549: the same dialog, opened straight into full-text search.
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [importTarget, setImportTarget] = useState<{ machineId: string; agent: HistoryAgent; query: string } | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // ── global ⌘K / Ctrl+K listener (capture phase + preventDefault) ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // isAppChord（不是 metaKey||ctrlKey）：macOS 上 Ctrl+K 是终端 readline 的
      // kill-line，不能被 app 截走（2026-08-14 golden 差分实测坐实）。
      if (isAppChord(e) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown, true); // capture
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  // B-865: ⌘⇧F (Ctrl+Shift+F) opens the same palette — except inside a web
  // terminal off macOS, whose own find owns that chord (matchSessionSearchChord).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!matchSessionSearchChord(e, IS_MAC, !!target?.closest('.xterm'))) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((prev) => !prev);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // programmatic open (sidebar's mobile search icon)
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  // B-576: ⌘P quick open takes over — one modal at a time.
  useEffect(() => onQuickOpen(() => setOpen(false)), []);
  // B-831: page-blocking — takes an `interaction` turn (overlayQueue), so the
  // release notes step aside and a sign-in expiry dialog is never stacked on it.
  const turn = useOverlayTurn(open, OVERLAY_PRIORITY.interaction);

  const dialogs = useMemo<PaletteDialogs>(() => ({
    newChat: (target, draft) => setNewChatDialog({ target, draft }),
    newTerminalAt: () => setShowNewTerminal(true),
    attachTmux: () => setShowAttachTmux(true),
    importHistory: (agent) => setShowImport(agent),
    searchHistory: () => setShowHistorySearch(true),
    importFound: (target) => setImportTarget(target),
  }), []);

  return (
    <>
      {/* Mounted only while open: the panel subscribes to the board's
          derivation (useBoardItems), which must not run while closed. */}
      {open && turn && <CommandPalettePanel onClose={close} dialogs={dialogs} />}

      {newChatDialog && (
        <NewSessionModal
          initialLocation={newChatDialog.target}
          initialCommandDefault={newChatDialog.draft}
          onClose={() => setNewChatDialog(null)}
        />
      )}
      {showNewTerminal && <NewTerminalModal onClose={() => setShowNewTerminal(false)} />}
      {showAttachTmux && <AttachTmuxModal onClose={() => setShowAttachTmux(false)} />}
      {showImport && <ImportHistoryModal initialAgent={showImport} onClose={() => setShowImport(null)} />}
      {showHistorySearch && <ImportHistoryModal initialMode="search" onClose={() => setShowHistorySearch(false)} />}
      {importTarget && (
        <ImportHistoryModal
          initialMode="search"
          initialMachineId={importTarget.machineId}
          initialAgent={importTarget.agent}
          initialQuery={importTarget.query}
          onClose={() => setImportTarget(null)}
        />
      )}
    </>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
  return (
    <>
      {splitHighlights(text, ranges).map((seg, i) =>
        seg.hit ? <mark key={i} className="cp-mark">{seg.text}</mark> : <span key={i}>{seg.text}</span>)}
    </>
  );
}

/**
 * B-823: the settings index reads every key in English and Chinese, which
 * pulled the whole zh-Hans table into the startup chunk for everyone. It is
 * loaded when the palette first opens; settings hits join the results then.
 */
type SettingsIndexModule = typeof import('@/screens/settings/settingsIndex');
let settingsIndexLoad: Promise<SettingsIndexModule> | null = null;
function useSettingsIndex(): SettingsIndexModule | null {
  const [index, setIndex] = useState<SettingsIndexModule | null>(null);
  useEffect(() => {
    let live = true;
    (settingsIndexLoad ??= import('@/screens/settings/settingsIndex')).then(
      (mod) => { if (live) setIndex(mod); },
      () => { settingsIndexLoad = null; },
    );
    return () => { live = false; };
  }, []);
  return index;
}

function CommandPalettePanel({ onClose: close, dialogs }: { onClose: () => void; dialogs: PaletteDialogs }) {
  const { t, lang } = useTranslation();
  const settingsIndex = useSettingsIndex();
  const navigate = useNavigate();
  const location = useLocation();

  const [query, setQuery] = useState('');
  const ime = useImeGuard();
  // Highlight is tracked by row KEY (paletteModel.resolveActiveIndex), so
  // rows inserted/removed elsewhere never move it under the user.
  const [active, setActive] = useState<PaletteActive | null>(null);
  // B-865: did the user move the highlight since the query last changed (arrows / pointer)?
  const chosenRef = useRef(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sessions = useSessions();
  const machines = storage((s) => s.machines);
  const terminals = useTerminalSessions((s) => s.terminals);
  const boardItems = useBoardItems();
  const unreadIds = storage((s) => s.unreadSessionIds);

  // ── B-865: session search (titles + what was said), narrowed by the filter bar ──
  const [filters, setFilters] = useState<SessionSearchFilters>(PALETTE_DEFAULT_FILTERS);
  const parsedQuery = useMemo(() => parseSidebarQuery(query), [query]);
  const contentText = contentSearchText(parsedQuery.text);
  const search = useSessionSearch(query, contentText !== '', filters);
  const passingIds = useMemo(() => new Set(search.passing.map((f) => f.session.id)), [search.passing]);
  const searchTerms = search.q.terms;

  /** Open a session; with a snippet, land on that hit (B-650 chat jump). */
  const openHit = useCallback((sessionId: string, snippet?: ResultSnippet) => {
    if (snippet && searchTerms.length) {
      requestChatJump(sessionId, {
        terms: searchTerms,
        ...(snippet.messageId ? { messageId: snippet.messageId } : { snippet: snippet.text }),
        ...(snippet.at !== undefined ? { at: snippet.at } : {}),
      });
    }
    navigate(`/session/${sessionId}`);
  }, [navigate, searchTerms]);
  const openSearchRow = useCallback((row: SessionSearchRow, snippet?: ResultSnippet) => {
    if (row.importable) {
      dialogs.importFound({ machineId: row.importable.machineId, agent: row.importable.entry.agent, query: searchTerms.join(' ') });
      return;
    }
    if (row.sessionId) openHit(row.sessionId, snippet ?? row.snippets[0]);
  }, [dialogs, openHit, searchTerms]);

  // current session id from the route (/session/:id)
  const currentSessionId = useMemo(() => {
    const m = location.pathname.match(/^\/session\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);

  // focus input on open
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // ── B-552 等我看: the board's waiting column (sessions), frozen at open ──
  // Membership and order freeze once the session store is ready
  // (freezeNeedsYouKeys); before that the section isn't rendered at all. Status
  // marks keep reading the live items.
  const dataReady = storage((s) => s.isDataReady);
  const liveNeedsYou = useMemo(
    () => selectNeedsYouSessions(boardItems, { currentSessionId }),
    [boardItems, currentSessionId],
  );
  const frozenNeedsYou = useRef<readonly string[] | null>(null);
  frozenNeedsYou.current = freezeNeedsYouKeys(frozenNeedsYou.current, dataReady, liveNeedsYou);
  const frozenKeys = frozenNeedsYou.current;
  const needsYou = useMemo(
    () => (frozenKeys ? resolveFrozenRows(frozenKeys, boardItems) : []),
    [boardItems, frozenKeys],
  );

  // one online machine → direct create; 0 / >1 → picker (shared entry point)
  const openNewTerminal = useCallback(() => createTerminalOrPick(navigate), [navigate]);

  const renameCurrent = useCallback(async () => {
    if (!currentSessionId) return;
    const current = (sessions ?? []).find(
      (s): s is Exclude<typeof s, string> => typeof s !== 'string' && s.id === currentSessionId,
    );
    const defaultValue = current ? getSessionName(current) : '';
    const next = await Modal.prompt(
      t('commandPalette.renamePromptTitle'),
      undefined,
      { defaultValue },
    );
    if (next != null && next.trim()) {
      await sessionUpdateTitle(currentSessionId, next.trim());
    }
  }, [currentSessionId, sessions, t]);

  const archiveCurrent = useCallback(async () => {
    if (!currentSessionId) return;
    const current = (sessions ?? []).find(
      (session): session is Exclude<typeof session, string> =>
        typeof session !== 'string' && session.id === currentSessionId,
    );
    if (!current) return;
    try {
      await archiveSessionNow(current);
      // B-111: leave the archived detail view onto the next session.
      navigate(nextSessionPathAfterClose(currentSessionId));
    } catch (error) {
      console.error('[commandPalette] archive failed', error);
      Modal.alert(t('common.error'), t('sessionInfo.failedToArchiveSession'));
    }
  }, [currentSessionId, navigate, sessions, t]);

  // ── build the full item index (unfiltered) ──
  const happyBotEntryVisible = useLocalSetting('happyBotEntryVisible');
  const items = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];

    // Actions
    out.push({
      key: 'action:new-terminal',
      group: 'actions',
      title: t('commandPalette.actionNewTerminal'),
      icon: <TerminalSquare size={16} />,
      haystack: (t('commandPalette.actionNewTerminal') as string).toLowerCase(),
      hint: NEW_TERMINAL_SHORTCUT_HINT,
      run: openNewTerminal,
    });
    out.push({
      // B-144: the deliberate variant — choose the working directory first, so
      // the configured startup command starts in the project, not in $HOME.
      key: 'action:new-terminal-at',
      group: 'actions',
      title: t('commandPalette.actionNewTerminalAt'),
      icon: <FolderOpen size={16} />,
      haystack: `terminal directory cwd ${(t('commandPalette.actionNewTerminalAt') as string).toLowerCase()}`,
      run: dialogs.newTerminalAt,
    });
    out.push({
      // B-281: the dedicated attach picker (B-273 machinery).
      key: 'action:attach-tmux',
      group: 'actions',
      title: t('commandPalette.actionAttachTmux'),
      icon: <TerminalSquare size={16} />,
      haystack: `tmux attach session ${(t('commandPalette.actionAttachTmux') as string).toLowerCase()}`,
      run: dialogs.attachTmux,
    });
    out.push({
      // B-290: import a Claude Code conversation stored on a machine.
      key: 'action:import-claude-history',
      group: 'actions',
      title: t('commandPalette.actionImportClaude'),
      icon: <History size={16} />,
      haystack: `import claude code history conversation desktop resume ${(t('commandPalette.actionImportClaude') as string).toLowerCase()}`,
      run: () => dialogs.importHistory('claude'),
    });
    out.push({
      // B-464: import a Codex thread stored on a machine.
      key: 'action:import-codex-history',
      group: 'actions',
      title: t('commandPalette.actionImportCodex'),
      icon: <History size={16} />,
      haystack: `import codex history thread conversation desktop resume ${(t('commandPalette.actionImportCodex') as string).toLowerCase()}`,
      run: () => dialogs.importHistory('codex'),
    });
    out.push({
      // B-549: search what was said in a machine's Claude Code / Codex history.
      key: 'action:search-history',
      group: 'actions',
      title: t('commandPalette.actionSearchHistory'),
      icon: <History size={16} />,
      haystack: `search history full text conversation transcript find content claude codex ${(t('commandPalette.actionSearchHistory') as string).toLowerCase()}`,
      run: dialogs.searchHistory,
    });
    out.push({
      // B-300: the "+" menu's last entry, mirrored here — ⌘K must not be the
      // one surface that cannot reach the connect-a-machine guide.
      key: 'action:connect-machine',
      group: 'actions',
      title: t('connectMachine.cta'),
      icon: <HardDrive size={16} />,
      haystack: `connect machine add daemon install cli ${(t('connectMachine.cta') as string).toLowerCase()}`,
      run: () => navigate('/machine/connect'),
    });
    out.push({
      key: 'action:new-chat',
      group: 'actions',
      title: t('commandPalette.actionNewChat'),
      icon: <Plus size={16} />,
      haystack: (t('commandPalette.actionNewChat') as string).toLowerCase(),
      // Quick create (same flow as the sidebar "+"): spawn directly, fall
      // back to the full dialog only when the quick path can't decide.
      run: () => void createChatOrConfigure(navigate, (target) => dialogs.newChat(target), { location }),
    });
    out.push({
      key: 'action:new-chat-advanced',
      group: 'actions',
      title: t('commandPalette.actionNewChatAdvanced'),
      icon: <MessageSquare size={16} />,
      haystack: (t('commandPalette.actionNewChatAdvanced') as string).toLowerCase(),
      run: () => dialogs.newChat(),
    });
    if (currentSessionId) {
      // B-576: phone entry to the session page's ⌘P quick open.
      out.push({
        key: 'action:quick-open',
        group: 'actions',
        title: t('quickOpen.paletteAction'),
        icon: <FileSearch size={16} />,
        haystack: `open file quick find path ${(t('quickOpen.paletteAction') as string).toLowerCase()}`,
        hint: IS_MAC ? '⌘P' : 'Ctrl+P',
        run: openQuickOpen,
      });
      out.push({
        key: 'action:rename',
        group: 'actions',
        title: t('commandPalette.actionRenameSession'),
        icon: <Pencil size={16} />,
        haystack: (t('commandPalette.actionRenameSession') as string).toLowerCase(),
        run: renameCurrent,
      });
      const currentSession = (sessions ?? []).find(
        (session): session is Exclude<typeof session, string> =>
          typeof session !== 'string' && session.id === currentSessionId,
      );
      const currentMachine = currentSession?.metadata?.machineId
        ? machines[currentSession.metadata.machineId]
        : undefined;
      // recoverability: restore (inactive+recoverable) and archive (not yet
      // archived) are INDEPENDENT — a merely-offline session gets both.
      if (canOfferRestore(currentSession, currentMachine)) {
        out.push({
          key: 'action:restore',
          group: 'actions',
          title: t('commandPalette.actionRestoreSession'),
          icon: <RotateCcw size={16} />,
          haystack: (t('commandPalette.actionRestoreSession') as string).toLowerCase(),
          run: () => void restoreSessionOrAlert(currentSessionId),
        });
      }
      if (currentSession && currentSession.archivedAt == null) {
        out.push({
          key: 'action:archive',
          group: 'actions',
          title: t('commandPalette.actionArchiveSession'),
          icon: <Archive size={16} />,
          haystack: (t('commandPalette.actionArchiveSession') as string).toLowerCase(),
          run: archiveCurrent,
        });
      }
    }
    if (happyBotEntryVisible) out.push({
      key: 'action:teams',
      group: 'actions',
      title: lang.startsWith('zh') ? '团队' : 'Teams',
      icon: <UsersRound size={16} />,
      haystack: 'happy bot teams 团队 机器人',
      run: () => navigate('/teams'),
    });
    out.push({
      key: 'action:clipboard-history',
      group: 'actions',
      title: t('commandPalette.actionClipboardHistory'),
      icon: <ClipboardList size={16} />,
      haystack: (t('commandPalette.actionClipboardHistory') as string).toLowerCase(),
      run: openClipboardHistory,
    });
    out.push({
      key: 'action:notes',
      group: 'actions',
      title: t('commandPalette.actionNotes'),
      icon: <StickyNote size={16} />,
      haystack: `notes ${(t('commandPalette.actionNotes') as string).toLowerCase()}`,
      hint: IS_MAC ? '⌘J' : 'Ctrl+J',
      run: toggleNotesPanel,
    });
    out.push({
      key: 'action:notes-all',
      group: 'actions',
      title: t('commandPalette.actionAllNotes'),
      icon: <StickyNote size={16} />,
      haystack: `notes ${(t('commandPalette.actionAllNotes') as string).toLowerCase()}`,
      run: () => navigate('/notes'),
    });
    out.push({
      key: 'action:todos',
      group: 'actions',
      title: t('commandPalette.actionTodos'),
      icon: <ListChecks size={16} />,
      haystack: `todos todo ${(t('commandPalette.actionTodos') as string).toLowerCase()}`,
      run: () => navigate('/todos'),
    });
    out.push({
      key: 'action:settings',
      group: 'actions',
      title: t('commandPalette.actionOpenSettings'),
      icon: <Settings size={16} />,
      haystack: (t('commandPalette.actionOpenSettings') as string).toLowerCase(),
      run: () => navigate('/settings'),
    });

    // Sessions (nav) — B-865: every session passing the filter bar (archived
    // ones only when the status chip asks), in the sidebar's order, then the
    // rest (archived) newest first.
    const order = new Map<string, number>();
    (sessions ?? []).forEach((s, i) => { if (typeof s !== 'string') order.set(s.id, i); });
    const ordered = [...search.passing].sort((a, b) =>
      (order.get(a.session.id) ?? Infinity) - (order.get(b.session.id) ?? Infinity) || b.doc.updatedAt - a.doc.updatedAt);
    for (const { session: s, doc } of ordered) {
      // B-091/B-105 belt-and-braces: sessionsData already excludes hidden
      // sessions (assistant, terminal mirrors) at the source; keep the
      // predicate here so a storage-lane refactor can't leak them into search.
      if (isHiddenSession(s)) continue;
      const title = getSessionName(s);
      const sub = getSessionSubtitle(s);
      const path = s.metadata?.path ?? '';
      out.push({
        key: `session:${s.id}`,
        group: 'sessions',
        title,
        subtitle: sub,
        icon: <MessageSquare size={16} />,
        haystack: `${title} ${sub} ${path}`.toLowerCase(),
        tags: s.metadata?.tags,
        ...(doc.archived ? { badge: 'archived' as const } : {}),
        run: () => navigate(`/session/${s.id}`),
      });
    }

    // Terminals (nav)
    for (const term of terminals) {
      const sub = term.machineName;
      out.push({
        key: `terminal:${term.id}`,
        group: 'terminals',
        title: term.title,
        subtitle: sub,
        icon: <TerminalSquare size={16} />,
        haystack: `${term.title} ${sub}`.toLowerCase(),
        tags: term.tags,
        run: () => navigate(`/terminal/${term.machineId}?tid=${term.id}`),
      });
    }

    return out;
  }, [
    sessions,
    search.passing,
    happyBotEntryVisible,
    lang,
    machines,
    terminals,
    currentSessionId,
    location,
    t,
    navigate,
    dialogs,
    openNewTerminal,
    renameCurrent,
    archiveCurrent,
  ]);

  // B-552 等我看 rows (empty query only), rendered like the session rows plus
  // the sidebar's status mark and "how long ago".
  const needsYouItems = useMemo<CommandItem[]>(() => {
    const byId = new Map<string, Exclude<NonNullable<typeof sessions>[number], string>>();
    for (const s of sessions ?? []) if (typeof s !== 'string') byId.set(s.id, s);
    return needsYou.flatMap((item) => {
      const s = byId.get(item.key);
      // B-865: the filter bar narrows 等我看 too.
      if (!s || !passingIds.has(s.id)) return [];
      const title = getSessionName(s);
      return [{
        key: `needs:${s.id}`,
        group: 'needsYou' as const,
        title,
        subtitle: getSessionSubtitle(s),
        icon: <MessageSquare size={16} />,
        haystack: title.toLowerCase(),
        status: {
          execution: boardItemExecution(item),
          unread: unreadIds.has(s.id),
          backgroundTasks: item.backgroundTasks,
          flavor: s.metadata?.flavor,
          legacy: item.legacyStatus,
          at: item.attentionSince ?? item.lastActivityAt,
        },
        run: () => navigate(`/session/${s.id}`),
      }];
    });
  }, [needsYou, sessions, unreadIds, navigate, passingIds]);

  // ── filter (paletteModel: substring + sidebar `#tag` grammar, unchanged),
  // then one display order shared by rendering and ↑↓/Enter ──
  const filtered = useMemo<CommandItem[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // Empty query: 等我看 on top; those sessions leave the plain list.
      const pinned = new Set(needsYouItems.map((it) => it.key.slice('needs:'.length)));
      return orderPaletteItems([
        ...needsYouItems,
        ...items.filter((it) => !(it.group === 'sessions' && pinned.has(it.key.slice('session:'.length)))),
      ]);
    }
    // B-575: item-level settings hits — their own ranking (settingsIndex),
    // appended as one 「设置」 section; Enter deep-links to the row.
    const settingsText = paletteSettingsQuery(query);
    const webPush = isWebPushSupported() && getNotificationPermission() !== 'unsupported';
    const settingsRows: CommandItem[] = settingsText && settingsIndex
      ? settingsIndex.searchSettings(settingsText, { webPush }).slice(0, PALETTE_SETTINGS_LIMIT).map(({ entry }) => ({
          key: `setting:${entry.id}`,
          group: 'settings' as const,
          title: settingsIndex.displayText(entry.title, lang, t),
          subtitle: settingsIndex.displayText(settingsIndex.sectionTitle(entry.section), lang, t),
          icon: <Settings size={16} />,
          haystack: '',
          run: () => navigate(settingsIndex.settingHref(entry)),
        }))
      : [];
    // B-865: one row per session. A title match keeps its 「会话」 row and gains
    // its content snippets (Enter still just opens it — a quick switch must
    // not land mid-transcript; a snippet click jumps). Sessions found only by
    // what was said form 「对话内容」, after the instant groups.
    const base = filterPaletteItems(items, query);
    const titleIds = new Set(base.filter((it) => it.group === 'sessions').map((it) => it.key.slice('session:'.length)));
    const split = splitSearchRows(search.rows, titleIds);
    const byKey = new Map(items.map((it) => [it.key, it]));
    const extraTitle = split.titleRows.flatMap((row) => {
      const it = byKey.get(`session:${row.sessionId}`);
      return it ? [it] : [];
    });
    const withSnippets = (it: CommandItem): CommandItem => {
      if (it.group !== 'sessions') return it;
      const id = it.key.slice('session:'.length);
      const snippets = split.attach.get(id);
      return snippets ? { ...it, snippets, openSnippet: (sn) => { close(); openHit(id, sn); } } : it;
    };
    const contentRows: CommandItem[] = split.contentRows.map((row) => ({
      key: `content:${row.key}`,
      group: 'content' as const,
      title: row.title,
      titleRanges: row.titleRanges,
      subtitle: row.subtitle,
      subtitleRanges: row.subtitleRanges,
      icon: row.importable ? <Download size={16} /> : <MessageSquare size={16} />,
      haystack: '',
      snippets: row.snippets,
      openSnippet: (sn) => { close(); openSearchRow(row, sn); },
      ...(row.importable ? { badge: 'importable' as const } : row.archived ? { badge: 'archived' as const } : {}),
      updatedAt: row.updatedAt,
      run: () => openSearchRow(row),
    }));
    const matched = orderPaletteItems([...[...base, ...extraTitle].map(withSnippets), ...contentRows, ...settingsRows]);
    const draft = newChatDraftFor(query, matched);
    if (draft == null) return matched;
    const createTitle = t('commandPalette.actionNewChatWithQuery', { query: draft });
    return [...matched, {
      key: CREATE_ROW_KEY,
      group: 'create' as const,
      title: createTitle,
      icon: <MessageSquarePlus size={16} />,
      haystack: '',
      // Same entry as "New chat"; the query becomes the composer draft (quick
      // path) or the dialog's initial instruction (configure path) — never sent
      // on its own.
      run: () => void createChatOrConfigure(navigate, (target) => dialogs.newChat(target, draft), { location, draft }),
    }];
  }, [items, needsYouItems, query, t, lang, navigate, dialogs, location, settingsIndex, search.rows, close, openHit, openSearchRow]);

  const keys = useMemo(() => filtered.map((it) => it.key), [filtered]);
  const activeIndex = resolveActiveIndex(keys, active);

  // Pin the highlight to a concrete key: an implicit "first row" would
  // otherwise jump when a section is inserted above it, and a vanished row's
  // fallback neighbour becomes the new pinned row.
  useEffect(() => {
    const adopted = adoptFirstResult(keys, active, chosenRef.current);
    if (adopted !== active) { setActive(adopted); return; }
    const key = activeIndex >= 0 ? keys[activeIndex] : undefined;
    if (key !== undefined && (active?.key !== key || active.index !== activeIndex)) {
      setActive({ key, index: activeIndex });
    }
  }, [keys, activeIndex, active]);

  // scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cp-row.is-active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const runItem = useCallback(
    async (item: CommandItem | undefined) => {
      if (!item) return;
      close();
      await item.run();
    },
    [close],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME guard: while a CJK composition is active, Enter/arrows/Escape
      // operate the candidate window — they must not run items, move the
      // selection, or close the palette.
      if (ime.isGuarded(e)) return;
      // B-714: a filter picker's (portalled) popup owns its keys, Esc included.
      if (pickerOwnsKey(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      // ↑↓ / Enter drive the list only from the search field: a focused filter
      // chip or snippet button keeps its own keys.
      if (e.target !== inputRef.current) return;
      // B-655: only a bare ↑/↓ moves the selection; with a modifier it is a
      // caret/selection key for the search field.
      const delta = listArrowDelta(e);
      if (delta !== null) {
        e.preventDefault();
        chosenRef.current = true;
        setActive((a) => moveActive(keys, a, delta));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(activeIndex >= 0 ? filtered[activeIndex] : undefined);
      }
    },
    [filtered, keys, activeIndex, close, runItem, ime],
  );

  // render grouped list (dividers by group label); `filtered` is already in
  // display order, so a row's flat index is its keyboard index.
  // B-865: the 「对话内容」 group's state line — machines being searched, offline,
  // on an old CLI, failing or still indexing (the rest of the list never waits).
  const coverage = search.coverage;
  const contentStatus = useMemo<{ text: string; detail: string; incomplete: boolean } | null>(() => {
    if (!contentText) return null;
    if (search.contentSkipped) return { text: t('sessionSearch.contentNotIndexed'), detail: '', incomplete: true };
    const parts: string[] = [];
    if (coverage.pending.length) parts.push(t('sessionSearch.searchingMachines', { count: coverage.pending.length }));
    if (coverage.offline.length) parts.push(t('sessionSearch.machinesOffline', { count: coverage.offline.length }));
    if (coverage.unsupported.length) parts.push(t('sessionSearch.machinesOldCli', { count: coverage.unsupported.length }));
    if (coverage.failed.length) parts.push(t('sessionSearch.machinesFailed', { count: coverage.failed.length }));
    if (coverage.indexing.length) parts.push(t('sessionSearch.machinesIndexing', { count: coverage.indexing.length }));
    if (!parts.length) return null;
    const names = (list: { name: string }[]) => list.map((m) => m.name).join(', ');
    const detail = [
      coverage.offline.length ? `${t('sessionSearch.offlineLabel')}: ${names(coverage.offline)}` : '',
      coverage.unsupported.length ? `${t('sessionSearch.oldCliLabel')}: ${names(coverage.unsupported)}` : '',
      coverage.failed.length ? `${t('sessionSearch.failedLabel')}: ${names(coverage.failed)}` : '',
      coverage.indexing.length ? `${t('sessionSearch.indexingLabel')}: ${coverage.indexing.map((m) => `${m.name}${m.progress ? ` ${m.progress.done}/${m.progress.total}` : ''}`).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return { text: parts.join(' · '), detail, incomplete: coverage.incomplete };
  }, [contentText, search.contentSkipped, coverage, t]);

  const groups = useMemo(() => {
    const labels: Record<PaletteGroup, string | null> = {
      needsYou: t('sidebar.groupWaiting'),
      actions: t('commandPalette.groupActions'),
      sessions: t('commandPalette.groupSessions'),
      content: t('commandPalette.groupContent'),
      terminals: t('commandPalette.groupTerminals'),
      settings: t('settings.title'),
      create: null,
    };
    const out: { group: PaletteGroup; label: string | null; rows: { it: CommandItem; index: number }[] }[] = [];
    filtered.forEach((it, index) => {
      const last = out[out.length - 1];
      if (last && last.group === it.group) last.rows.push({ it, index });
      else out.push({ group: it.group, label: labels[it.group], rows: [{ it, index }] });
    });
    // No content rows yet (or none at all) but a state to report: the group
    // header still stands where the rows will arrive.
    if (contentStatus && !out.some((g) => g.group === 'content')) {
      const rank = (g: PaletteGroup) => PALETTE_GROUP_ORDER.indexOf(g);
      const at = out.findIndex((g) => rank(g.group) > rank('content'));
      const placeholder = { group: 'content' as const, label: labels.content, rows: [] };
      if (at < 0) out.push(placeholder);
      else out.splice(at, 0, placeholder);
    }
    return out;
  }, [filtered, t, contentStatus]);

  const statusOptions: Array<{ value: StatusFilter; label: string }> = [
    { value: 'live', label: t('sessionSearch.statusNotArchived') },
    { value: 'waiting', label: t('sessionSearch.statusWaiting') },
    { value: 'all', label: t('sessionSearch.statusIncludeArchived') },
    { value: 'archived', label: t('sessionSearch.statusArchivedOnly') },
  ];
  const timeOptions: Array<{ value: TimeFilter; label: string }> = [
    { value: 'any', label: t('sessionSearch.timeAny') },
    { value: '1d', label: t('sessionSearch.time1d') },
    { value: '7d', label: t('sessionSearch.time7d') },
    { value: '30d', label: t('sessionSearch.time30d') },
  ];
  const agents = useMemo(
    () => [...new Set(search.facts.map((f) => f.agent).filter((a): a is string => !!a))].sort(),
    [search.facts],
  );
  const setFilter = <K extends keyof SessionSearchFilters>(k: K, v: SessionSearchFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setActive(null);
  };
  const roleLabel = (sn: ResultSnippet) =>
    sn.role === 'user' ? t('sessionSearch.roleUser') : sn.role === 'assistant' ? t('sessionSearch.roleAgent') : t('sessionSearch.roleTool');
  const now = search.now;

  return (
    <div
      className="cp-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="cp-panel"
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
        // Composition events bubble from the search input; tracking them
        // here keeps the panel-level key guard IME-aware.
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
      >
        <div className="cp-search">
          <Search size={16} className="cp-search-icon" />
          <input
            ref={inputRef}
            className="cp-search-input"
            type="text"
            value={query}
            placeholder={t('commandPalette.placeholder')}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(null);
              chosenRef.current = false;
            }}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t('commandPalette.placeholder')}
          />
          <button type="button" className="cp-close" onClick={close} aria-label={t('common.close')} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        {/* B-865: the old session-search filters, one compact row (scrolls sideways on a phone). */}
        <div className="cp-filters" role="group" aria-label={t('sessionSearch.filtersLabel')}>
          <SelectMenu
            variant="chip"
            className={`cp-filter${filters.status !== PALETTE_DEFAULT_FILTERS.status ? ' is-set' : ''}`}
            label={t('sessionSearch.statusLabel')}
            value={filters.status}
            onChange={(v) => setFilter('status', v)}
            options={statusOptions}
          />
          <Combobox
            variant="chip"
            className={`cp-filter${filters.projectId ? ' is-set' : ''}`}
            label={t('sessionSearch.projectLabel')}
            value={filters.projectId ?? ''}
            onChange={(v) => setFilter('projectId', v || null)}
            options={[
              { value: '', label: t('sessionSearch.projectAny') },
              ...search.projects.projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <Combobox
            variant="chip"
            className={`cp-filter${filters.machineId ? ' is-set' : ''}`}
            label={t('sessionSearch.machineLabel')}
            value={filters.machineId ?? ''}
            onChange={(v) => setFilter('machineId', v || null)}
            options={[
              { value: '', label: t('sessionSearch.machineAny') },
              ...search.machines.map((m) => ({ value: m.id, label: machineLabel(m), ...(m.active ? {} : { meta: t('sessionSearch.offlineLabel') }) })),
            ]}
          />
          <SelectMenu
            variant="chip"
            className={`cp-filter${filters.agent ? ' is-set' : ''}`}
            label={t('sessionSearch.agentLabel')}
            value={filters.agent ?? ''}
            onChange={(v) => setFilter('agent', v || null)}
            options={[{ value: '', label: t('sessionSearch.agentAny') }, ...agents.map((a) => ({ value: a, label: a }))]}
          />
          <SelectMenu
            variant="chip"
            className={`cp-filter${filters.time !== 'any' ? ' is-set' : ''}`}
            label={t('sessionSearch.timeLabel')}
            value={filters.time}
            onChange={(v) => setFilter('time', v)}
            options={timeOptions}
          />
          {paletteFiltersActive(filters) ? (
            <button type="button" className="cp-filters-reset" onClick={() => { setFilters(PALETTE_DEFAULT_FILTERS); setActive(null); }}>
              {t('sessionSearch.resetFilters')}
            </button>
          ) : null}
        </div>

        <div className="cp-list vh-scroll-fade" ref={listRef}>
          {groups.length === 0 ? (
            <div className="cp-empty">{t('commandPalette.empty')}</div>
          ) : (
            groups.map((grp) => (
              <div key={grp.group} className={`cp-group cp-group--${grp.group}`}>
                {grp.label ? (
                  <div className="cp-group-label">
                    <span>{grp.label}</span>
                    {grp.group === 'content' && contentStatus ? (
                      <span
                        className={`cp-group-status${contentStatus.incomplete ? ' is-incomplete' : ''}`}
                        role="status"
                        title={contentStatus.detail || undefined}
                      >
                        {contentStatus.text}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {grp.group === 'content' && contentStatus?.detail ? (
                  <div className="cp-group-detail">{contentStatus.detail.split('\n').map((l) => <div key={l}>{l}</div>)}</div>
                ) : null}
                {grp.rows.map(({ it, index }) => (
                  <div
                    key={it.key}
                    className={`cp-row${index === activeIndex ? ' is-active' : ''}`}
                    onMouseMove={() => { if (index !== activeIndex) { chosenRef.current = true; setActive({ key: it.key, index }); } }}
                  >
                  <button
                    type="button"
                    className={`cp-item${index === activeIndex ? ' is-active' : ''}`}
                    onClick={() => runItem(it)}
                  >
                    <span className="cp-item-icon">{it.icon}</span>
                    <span className="cp-item-text">
                      <span className="cp-item-title">
                        {it.titleRanges ? <Highlighted text={it.title} ranges={it.titleRanges} /> : it.title}
                      </span>
                      {it.subtitle ? (
                        <span className="cp-item-sub">
                          {it.subtitleRanges ? <Highlighted text={it.subtitle} ranges={it.subtitleRanges} /> : it.subtitle}
                        </span>
                      ) : null}
                    </span>
                    {it.badge ? (
                      <span className="cp-badge">
                        {it.badge === 'archived' ? <Archive size={11} aria-hidden /> : <Download size={11} aria-hidden />}
                        {it.badge === 'archived' ? t('sessionSearch.archivedBadge') : t('sessionSearch.importableBadge')}
                      </span>
                    ) : null}
                    {it.updatedAt !== undefined ? <span className="cp-item-age">{formatSessionAge(it.updatedAt, now)}</span> : null}
                    {it.status ? (
                      <span className="cp-item-trail">
                        <PaletteStatusMark
                          execution={it.status.execution}
                          unread={it.status.unread}
                          backgroundTasks={it.status.backgroundTasks}
                          flavor={it.status.flavor}
                          legacy={it.status.legacy}
                        />
                        <span className="cp-item-age">{formatLastSeen(it.status.at)}</span>
                      </span>
                    ) : null}
                    {it.hint ? <kbd className="cp-item-hint">{it.hint}</kbd> : null}
                  </button>
                  {it.snippets?.length ? (
                    <div className="cp-snippets">
                      {it.snippets.map((sn, k) => (
                        <button key={k} type="button" className="cp-snippet" onClick={() => it.openSnippet?.(sn)}>
                          <span className="cp-snippet-role">{roleLabel(sn)}</span>
                          <span className="cp-snippet-text"><Highlighted text={sn.text} ranges={sn.ranges} /></span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="cp-footer">
          <span>{t('commandPalette.hintNavigate')}</span>
          <span>{t('commandPalette.hintSelect')}</span>
          <span>{t('commandPalette.hintClose')}</span>
          <span className="cp-footer-entry">{COMMAND_PALETTE_HINT} · {SESSION_SEARCH_HINT}</span>
        </div>
      </div>
    </div>
  );
}
