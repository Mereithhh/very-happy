import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Search, Plus, Settings, X, TerminalSquare, MoreHorizontal, MessageSquare, PanelLeftClose, LayoutGrid, SlidersHorizontal, ArrowUp, ArrowDown, Pencil, Archive, Trash2 } from 'lucide-react';
import { useSessions, useSetting, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createTerminalOrPick } from '@/app/newTerminal';
import { createChatOrConfigure } from '@/app/newChat';
import { getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { confirmArchiveSession, confirmDeleteSession, confirmDeleteTerminal, saveRowRename, collectAllTags } from '@/app/rowActions';
import type { Session } from '@/sync/storageTypes';
import { StatusDot, CyberMark, TagChip, TagOverflowChip, ActionDropdownMenu, ActionContextMenu, type MenuItemDef } from '@/ui';
import { useSocketStatus, socketToStatus } from '@/app/useConnection';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { useTranslation } from '@/i18n/useTranslation';
import { isImeGuardedEvent } from '@/utils/ime';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { useBoardAttentionCount } from '@/screens/board/useBoardItems';
import { NewSessionModal } from './NewSessionModal';
import { RenameModal } from './RenameModal';
import { splitPinnedRows } from './sidebarPins';
import { sortRowsByManualOrder, mergeLegacyPinned, planSidebarOrder, pruneEntries } from './sidebarOrder';
import { parseSidebarQuery, rowMatchesSidebarQuery, sidebarQueryIsEmpty } from './sidebarSearch';
import './sidebar.css';

function rowHref(r: Row): string {
  return r.kind === 'terminal' ? `/terminal/${r.machineId}?tid=${r.terminalId}` : `/session/${r.session!.id}`;
}

type Filter = 'active' | 'archived';

interface Row {
  key: string;
  kind: 'terminal' | 'session';
  ts: number;
  /** creation time — orders the unkeyed "new rows" zone (newest first) */
  createdAt: number;
  session?: Session;
  terminalId?: string;
  machineId?: string;
  title: string;
  subtitle: string;
  tags?: string[];
}

export function Sidebar() {
  const navigate = useNavigate();
  const sessions = useSessions();
  const socket = useSocketStatus();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [showNew, setShowNew] = useState(false);
  const [cmdHeld, setCmdHeld] = useState(false);
  const terminals = useTerminalSessions((s) => s.terminals);
  const toggleCollapsed = useSidebarPrefs((s) => s.toggleCollapsed);

  // Terminal list/agent-state ingestion lives in the AppLayout-level singleton
  // (sync/terminalSync.ts: daemon pushes) so it also runs with the sidebar
  // collapsed or on mobile detail screens. This component is a pure consumer
  // of its stores.

  const attentionCount = useBoardAttentionCount();

  const rows = useMemo<Row[] | null>(() => {
    if (!sessions) return null;
    const sessRows = sessions
      .filter((s): s is Session => typeof s !== 'string')
      .filter((s) => (filter === 'archived' ? !s.active : s.active))
      .map<Row>((s) => ({
        key: s.id,
        kind: 'session',
        ts: s.updatedAt || s.activeAt || s.createdAt,
        createdAt: s.createdAt,
        session: s,
        title: getSessionName(s),
        subtitle: getSessionSubtitle(s),
        tags: s.metadata?.tags,
      }));
    // terminals are always "live"; hidden only by the archived-only filter
    const termRows: Row[] =
      filter === 'archived'
        ? []
        : terminals.map((tm) => ({
            key: `t:${tm.id}`,
            kind: 'terminal',
            ts: tm.createdAt,
            createdAt: tm.createdAt,
            terminalId: tm.id,
            machineId: tm.machineId,
            title: tm.title || tm.machineName,
            subtitle: tm.machineName,
          }));
    const all = [...termRows, ...sessRows];
    // Search with `#tag` syntax: `#foo` filters by tag (prefix match), the
    // free-text remainder keeps the substring-on-title/subtitle behavior.
    const parsed = parseSidebarQuery(query);
    if (sidebarQueryIsEmpty(parsed)) return all;
    return all.filter((r) => rowMatchesSidebarQuery(r, parsed));
  }, [sessions, terminals, query, filter]);

  // ----- manual order -----
  // Synced settings field `sidebarOrder` — FULL manual ordering: every row
  // key maps to a fractional order key; unkeyed rows (new sessions/terminals)
  // render on top, newest first. While it's still empty the legacy
  // `pinnedRows` display applies (pinned section on top, activity order
  // below — section header removed); the FIRST drag materializes the whole
  // visible sequence into keys, folding the legacy pins in at their top
  // positions (mergeLegacyPinned). Ordering only shapes the ACTIVE list; the
  // archived view stays a plain activity list.
  const orderSetting = useSetting('sidebarOrder');
  const pinnedSetting = useSetting('pinnedRows'); // legacy, pre-materialization only
  const orderApplies = filter === 'active';
  const displayRows = useMemo<Row[] | null>(() => {
    if (!rows) return null;
    if (!orderApplies) return rows;
    if ((orderSetting ?? []).length > 0) return sortRowsByManualOrder(rows, orderSetting!);
    const { pinned, rest } = splitPinnedRows(rows, pinnedSetting ?? []);
    return [...pinned, ...rest];
  }, [rows, orderSetting, pinnedSetting, orderApplies]);

  // Commit a reorder: `seqKeys` = the final VISIBLE sequence, `movedKey` =
  // the row the user moved. Reads settings from the store (not the render
  // closure) — a drag can outlive a re-render. First commit materializes
  // everything (legacy pins folded in); afterwards the plan is minimal
  // (usually a single entry). Invisible keyed entries are carried untouched.
  const commitSeq = useCallback((seqKeys: string[], movedKey: string) => {
    const st = storage.getState().settings;
    const cur = st.sidebarOrder ?? [];
    const next =
      cur.length === 0
        ? planSidebarOrder([], mergeLegacyPinned(seqKeys, (st.pinnedRows ?? []).map((p) => p.key)), movedKey)
        : planSidebarOrder(cur, seqKeys, movedKey);
    if (next !== cur) sync.applySettings({ sidebarOrder: next });
  }, []);

  // Menu fallback (the only reorder path on coarse pointers): swap with the
  // adjacent row in the full visible list.
  const moveRow = useCallback((key: string, index: number, dir: -1 | 1) => {
    const list = rowsRef.current;
    if (!list) return;
    const j = index + dir;
    if (j < 0 || j >= list.length || list[index]?.key !== key) return;
    const keys = list.map((r) => r.key);
    [keys[index], keys[j]] = [keys[j], keys[index]];
    commitSeq(keys, key);
  }, [commitSeq]);

  // Drag ANY row to ANY position (fine pointers only; coarse pointers use the
  // row menu's move up/down instead). Pointer-event hand-rolled — same school
  // as SidebarResizeHandle, no dnd dependency. While dragging, an accent
  // insertion line tracks the drop slot; the list stays put (insertion-line
  // model, no live reorder) and the settings write happens once, on drop.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropLineY, setDropLineY] = useState<number | null>(null);

  const onRowPointerDown = (e: React.PointerEvent, key: string) => {
    if (e.button !== 0) return;
    if (!orderApplies) return; // archived view: plain list, nothing to order
    // Search narrows the visible rows — a drop position computed against a
    // partial picture would surprise; disable (the full list is one Esc away).
    if (query.trim()) return;
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
  // Suggestions: every tag currently in use across sessions, most-used first.
  const allTags = useMemo(() => collectAllTags(sessions), [sessions]);

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
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
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

  return (
    <div className="sb">
      <header className="sb-header">
        <div className="sb-brand">
          <CyberMark size={22} />
          <span className="sb-title">very happy</span>
        </div>
        <div className="sb-header-right">
          <StatusDot status={socketToStatus(socket)} pulse={socket === 'connecting'} title={socket} />
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
          <button className="sb-icon-btn" title={t('sidebar.collapse')} onClick={toggleCollapsed}>
            <PanelLeftClose size={17} />
          </button>
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
            ]}
          >
            <button className="sb-icon-btn" title={t('sidebar.newSession')}>
              <Plus size={18} />
            </button>
          </ActionDropdownMenu>
        </div>
      </header>

      <div className="sb-search">
        <Search size={15} className="sb-search-icon" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('sidebar.searchPlaceholder')}
          className="sb-search-input"
        />
        {query && (
          <button className="sb-search-clear" onClick={() => setQuery('')} aria-label="clear">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="sb-filter" role="tablist">
        {(['active', 'archived'] as Filter[]).map((f) => (
          <button
            key={f}
            className={`sb-filter-btn${filter === f ? ' is-on' : ''}`}
            onClick={() => setFilter(f)}
          >
            {t(f === 'active' ? 'sidebar.filterActive' : 'sidebar.filterArchived')}
          </button>
        ))}
        {/* Board lives on the header icon (badge included) — a third tab in
            the active/archived filter row read as clutter and was removed. */}
      </div>

      <div className={`sb-list${dragKey ? ' is-dragging' : ''}`} ref={listRef}>
        {displayRows === null ? (
          <div className="sb-loading">
            <StatusDot status="thinking" pulse /> {t('common.loading')}
          </div>
        ) : displayRows.length === 0 ? (
          <div className="sb-empty">{query ? t('sidebar.noResults') : t('sidebar.empty')}</div>
        ) : (
          <>
            {displayRows.map((r, i) => {
              // Menu reorder only where a drop is allowed: active view, no
              // search narrowing the sequence.
              const canReorder = orderApplies && !query.trim();
              return (
                <div
                  key={r.key}
                  data-dragkey={r.key}
                  className={`sb-drag-item${dragKey === r.key ? ' is-drag' : ''}`}
                  onPointerDown={(e) => onRowPointerDown(e, r.key)}
                >
                  <SidebarRow
                    row={r}
                    badge={cmdHeld && i < 9 ? i + 1 : undefined}
                    canMoveUp={i > 0}
                    canMoveDown={i < displayRows.length - 1}
                    onMove={canReorder ? (dir) => moveRow(r.key, i, dir) : undefined}
                    onRenameRequest={() => setRenameTarget(r)}
                  />
                </div>
              );
            })}
            {dragKey && dropLineY != null && (
              <div className="sb-drop-line" style={{ top: dropLineY }} aria-hidden />
            )}
          </>
        )}
      </div>

      <footer className="sb-footer">
        <button className="sb-footer-btn" onClick={() => navigate('/settings')}>
          <Settings size={16} /> {t('tabs.settings')}
        </button>
      </footer>

      {showNew && <NewSessionModal onClose={() => setShowNew(false)} />}
      {renameTarget && (
        <RenameModal
          defaultTitle={renameTarget.title}
          tags={renameTarget.kind === 'session' ? renameTarget.session!.metadata?.tags ?? [] : undefined}
          suggestions={allTags}
          onClose={() => setRenameTarget(null)}
          onSave={async (title, tags) => {
            const target = renameTarget;
            // shared flow (rowActions.saveRowRename): terminals are
            // title-only; sessions only write what actually changed.
            await saveRowRename(
              target.kind === 'terminal'
                ? { kind: 'terminal', terminalId: target.terminalId!, currentTitle: target.title }
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
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onRename: () => void;
  onMove?: (dir: -1 | 1) => void;
  onArchiveOrDelete: () => void;
  onDeleteSession?: () => void;
}): MenuItemDef[] {
  const { t } = opts;
  const items: MenuItemDef[] = [
    { key: 'rename', label: t('common.rename'), icon: Pencil, onSelect: opts.onRename },
  ];
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
  items.push({
    key: 'archive',
    label: opts.isTerminal ? t('common.delete') : t('common.archive'),
    icon: opts.isTerminal ? Trash2 : Archive,
    danger: true,
    separatorBefore: true,
    onSelect: opts.onArchiveOrDelete,
  });
  if (!opts.isTerminal && opts.onDeleteSession) {
    items.push({
      key: 'delete',
      label: t('common.delete'),
      icon: Trash2,
      danger: true,
      onSelect: opts.onDeleteSession,
    });
  }
  return items;
}

function SidebarRow({
  row,
  badge,
  canMoveUp,
  canMoveDown,
  onMove,
  onRenameRequest,
}: {
  row: Row;
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
  const { id } = useParams();
  const location = useLocation();
  const { t } = useTranslation();

  const isTerminal = row.kind === 'terminal';
  // Terminal rows are focused when the terminal route + tid match (they were
  // hardcoded unselected before, so the open terminal had no indicator).
  const selected = isTerminal
    ? location.pathname === `/terminal/${row.machineId}`
      && new URLSearchParams(location.search).get('tid') === row.terminalId
    : id === row.session!.id;
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

  const open = () =>
    isTerminal
      ? navigate(`/terminal/${row.machineId}?tid=${row.terminalId}`)
      : navigate(`/session/${row.session!.id}`);

  // Archive (session) / delete (terminal) / permanent delete — the flows,
  // confirms included, live in rowActions.ts and are shared with the board.
  const onArchiveOrDelete = () =>
    isTerminal
      ? confirmDeleteTerminal(row.machineId!, row.terminalId!, () => {
          // Leaving the screen BEFORE the kill: a mounted terminal screen (or
          // a refresh on its URL) would otherwise re-open the id and recreate
          // the killed tmux session (see rowActions.confirmDeleteTerminal).
          if (selected) navigate('/');
        })
      : confirmArchiveSession(row.session!);
  const onDeleteSession = () =>
    confirmDeleteSession(row.session!, () => {
      if (selected) navigate('/');
    });

  // ONE item list feeds both the "…" dropdown and the right-click menu.
  const menuItems = rowMenuItems({
    t,
    isTerminal,
    canMoveUp,
    canMoveDown,
    onRename: onRenameRequest,
    onMove,
    onArchiveOrDelete: () => void onArchiveOrDelete(),
    onDeleteSession: () => void onDeleteSession(),
  });

  return (
    <ActionContextMenu items={menuItems}>
    <div className={`sb-row${selected ? ' is-selected' : ''}`}>
      <button className="sb-row-main" onClick={open}>
        <span className={`sb-row-icon${isTerminal ? ' sb-row-icon--term' : ''}`}>
          {isTerminal ? (
            <span className="sb-row-term-icon" title={agentDot ? agentDotTitle : undefined}>
              <TerminalSquare size={16} />
              {agentDot && (
                <span className="sb-row-agent-dot">
                  <StatusDot status={agentDot} pulse={agentDot === 'thinking'} size={7} title={agentDotTitle} />
                </span>
              )}
            </span>
          ) : (
            <StatusDot status={dot} pulse={dot === 'thinking'} size={9} />
          )}
        </span>
        <span className="sb-row-text">
          <span className="sb-row-title-line">
            <span className="sb-row-title">{row.title}</span>
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
