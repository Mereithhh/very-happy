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
} from 'lucide-react';
import { useSessions, storage, useLocalSetting } from '@/sync/storage';
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
} from './paletteModel';
import { isWebPushSupported } from '@/sync/webPush';
import { getNotificationPermission } from '@/sync/webNotifications';
import { PaletteStatusMark } from './PaletteStatusMark';
import { listArrowDelta } from '@/utils/listArrowKey';
import { openSessionSearch, SESSION_SEARCH_HINT } from '@/screens/search/sessionSearchEvents';
import './commandpalette.css';
import { OVERLAY_PRIORITY, useOverlayTurn } from '@/app/overlayQueue';

/**
 * Programmatic open — the palette owns its open state; UI entry points that
 * can't press ⌘K (the sidebar's coarse-pointer search icon) dispatch this
 * event instead. Window event, not a store: the palette is a singleton and
 * nothing else needs to observe the state.
 */
const OPEN_EVENT = 'vh:command-palette-open';
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
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [newChatDialog, setNewChatDialog] = useState<{ target?: RecentMachinePath; draft?: string } | null>(null);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [showAttachTmux, setShowAttachTmux] = useState(false);
  const [showImport, setShowImport] = useState<ImportHistoryAgent | null>(null);
  // B-549: the same dialog, opened straight into full-text search.
  const [showHistorySearch, setShowHistorySearch] = useState(false);

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

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sessions = useSessions();
  const machines = storage((s) => s.machines);
  const terminals = useTerminalSessions((s) => s.terminals);
  const boardItems = useBoardItems();
  const unreadIds = storage((s) => s.unreadSessionIds);

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
      // B-650: the cross-session search panel (titles + every machine's content).
      key: 'action:search-sessions',
      group: 'actions',
      title: t('commandPalette.actionSearchSessions'),
      icon: <Search size={16} />,
      haystack: `search sessions find conversation content full text grep ${(t('commandPalette.actionSearchSessions') as string).toLowerCase()}`,
      hint: SESSION_SEARCH_HINT,
      run: openSessionSearch,
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

    // Sessions (nav) — filter out section-header strings from the legacy list
    for (const s of sessions ?? []) {
      if (typeof s === 'string') continue;
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
      if (!s) return [];
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
  }, [needsYou, sessions, unreadIds, navigate]);

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
    const matched = orderPaletteItems([...filterPaletteItems(items, query), ...settingsRows]);
    const draft = newChatDraftFor(query, matched);
    if (draft == null) return matched;
    const createTitle = t('commandPalette.actionNewChatWithQuery', { query: draft });
    return [...matched, {
      key: 'create:new-chat',
      group: 'create' as const,
      title: createTitle,
      icon: <MessageSquarePlus size={16} />,
      haystack: '',
      // Same entry as "New chat"; the query becomes the composer draft (quick
      // path) or the dialog's initial instruction (configure path) — never sent
      // on its own.
      run: () => void createChatOrConfigure(navigate, (target) => dialogs.newChat(target, draft), { location, draft }),
    }];
  }, [items, needsYouItems, query, t, lang, navigate, dialogs, location, settingsIndex]);

  const keys = useMemo(() => filtered.map((it) => it.key), [filtered]);
  const activeIndex = resolveActiveIndex(keys, active);

  // Pin the highlight to a concrete key: an implicit "first row" would
  // otherwise jump when a section is inserted above it, and a vanished row's
  // fallback neighbour becomes the new pinned row.
  useEffect(() => {
    const key = activeIndex >= 0 ? keys[activeIndex] : undefined;
    if (key !== undefined && (active?.key !== key || active.index !== activeIndex)) {
      setActive({ key, index: activeIndex });
    }
  }, [keys, activeIndex, active]);

  // scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cp-item.is-active');
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
      // B-655: only a bare ↑/↓ moves the selection; with a modifier it is a
      // caret/selection key for the search field.
      const delta = listArrowDelta(e);
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (delta !== null) {
        e.preventDefault();
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
  const groups = useMemo(() => {
    const labels: Record<PaletteGroup, string | null> = {
      needsYou: t('sidebar.groupWaiting'),
      actions: t('commandPalette.groupActions'),
      sessions: t('commandPalette.groupSessions'),
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
    return out;
  }, [filtered, t]);

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
            }}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <div className="cp-list vh-scroll-fade" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cp-empty">{t('commandPalette.empty')}</div>
          ) : (
            groups.map((grp) => (
              <div key={grp.group} className={`cp-group cp-group--${grp.group}`}>
                {grp.label ? <div className="cp-group-label">{grp.label}</div> : null}
                {grp.rows.map(({ it, index }) => (
                  <button
                    key={it.key}
                    type="button"
                    className={`cp-item${index === activeIndex ? ' is-active' : ''}`}
                    onMouseMove={() => { if (index !== activeIndex) setActive({ key: it.key, index }); }}
                    onClick={() => runItem(it)}
                  >
                    <span className="cp-item-icon">{it.icon}</span>
                    <span className="cp-item-text">
                      <span className="cp-item-title">{it.title}</span>
                      {it.subtitle ? <span className="cp-item-sub">{it.subtitle}</span> : null}
                    </span>
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
                ))}
              </div>
            ))
          )}
        </div>

        <div className="cp-footer">
          <span>{t('commandPalette.hintNavigate')}</span>
          <span>{t('commandPalette.hintSelect')}</span>
          <span>{t('commandPalette.hintClose')}</span>
        </div>
      </div>
    </div>
  );
}
