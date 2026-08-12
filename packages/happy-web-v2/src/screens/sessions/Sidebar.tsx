import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Search, Plus, Settings, X, TerminalSquare, MoreHorizontal, MessageSquare, PanelLeftClose, LayoutGrid, SlidersHorizontal, Pin, PinOff, ArrowUp, ArrowDown, Pencil, Archive, Trash2 } from 'lucide-react';
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
import { splitPinnedRows, togglePin, movePin, upsertPinAt, isPinned, prunePinned, type PinnedRow } from './sidebarPins';
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

  // ----- pinned rows -----
  // Synced settings field `pinnedRows` — array order IS the pinned section's
  // display order (cross-device). Pins only shape the ACTIVE list; archived
  // rows can't be pinned and the archived view stays a plain list.
  const pinnedSetting = useSetting('pinnedRows');
  const setPinnedSetting = useCallback((next: PinnedRow[]) => {
    sync.applySettings({ pinnedRows: next });
  }, []);
  const pinsApply = filter === 'active';
  const { pinned: pinnedRows, rest: restRows } = useMemo(() => {
    if (!rows || !pinsApply) return { pinned: [] as Row[], rest: (rows ?? []) as Row[] };
    return splitPinnedRows(rows, pinnedSetting ?? []);
  }, [rows, pinnedSetting, pinsApply]);

  // Drag ANY row (fine pointers only; coarse pointers use the row menu's
  // pin / move up/down instead). Pointer-event hand-rolled — same school as
  // SidebarResizeHandle, no dnd dependency.
  //
  // Semantics: picking a row up means "manual ordering". While dragging, an
  // accent insertion line tracks the drop slot inside the MANUAL zone (the
  // pinned section, plus the slot that creates it when empty). Dropping there
  // upserts the row into `pinnedRows` (synced) at that position — for an
  // unpinned row that both pins it and places it. Dropping below the divider
  // is the automatic zone: a pinned row is unpinned (returns to activity
  // order), an unpinned row is a no-op (activity order has no manual slots —
  // there is nothing to store). The list stays put during the drag; only the
  // line moves. The settings write happens once, on drop.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  // pin = insertion index in the pinned section (counted over the OTHER
  // pinned rows); auto = below the divider (unpin / no-op).
  const [dropKind, setDropKind] = useState<'pin' | 'auto' | null>(null);
  const [dropLineY, setDropLineY] = useState<number | null>(null);

  const onRowPointerDown = (e: React.PointerEvent, key: string) => {
    if (e.button !== 0) return;
    if (!pinsApply) return; // archived view: plain list, nothing to order
    // Search narrows the visible rows — a drop position computed against a
    // partial picture would surprise; disable (the full list is one Esc away).
    if (query.trim()) return;
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) return;
    if ((e.target as HTMLElement).closest('.sb-row-menu')) return;
    const list = listRef.current;
    if (!list) return;
    const startY = e.clientY;
    const state = { active: false, lastY: startY, raf: 0, drop: null as null | { kind: 'pin'; index: number } | { kind: 'auto' } };

    // Recompute the drop target + insertion line from a pointer Y. Rows are
    // measured from the live DOM ([data-dragkey], DOM order = pinned section
    // then the activity list); the dragged row itself doesn't count.
    const update = (clientY: number) => {
      const els = Array.from(list.querySelectorAll<HTMLElement>('[data-dragkey]'));
      const others = els.filter((el) => el.dataset.dragkey !== key);
      const pinCount = others.filter((el) => el.dataset.pinnedrow === '1').length;
      let idx = 0;
      for (const el of others) {
        const r = el.getBoundingClientRect();
        if (clientY > r.top + r.height / 2) idx++;
        else break; // DOM order — midpoints are monotone
      }
      const listRect = list.getBoundingClientRect();
      const yOf = (el: HTMLElement, edge: 'top' | 'bottom') =>
        (edge === 'top' ? el.getBoundingClientRect().top : el.getBoundingClientRect().bottom) -
        listRect.top +
        list.scrollTop;
      if (idx <= pinCount) {
        state.drop = { kind: 'pin', index: idx };
        setDropKind('pin');
        // line at the boundary the drop would insert into
        if (idx < pinCount) setDropLineY(yOf(others[idx], 'top'));
        else if (pinCount > 0) setDropLineY(yOf(others[pinCount - 1], 'bottom'));
        // empty manual zone (no pins, or the dragged row is the only pin):
        // the slot sits above the first row of the list
        else setDropLineY(els[0] ? yOf(els[0], 'top') : 0);
      } else {
        state.drop = { kind: 'auto' };
        setDropKind('auto');
        setDropLineY(null);
      }
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
      setDropKind(null);
      setDropLineY(null);
      if (!state.active) return;
      // The release lands on a row button — swallow the click it would
      // produce so a drag never doubles as "open this conversation".
      const swallow = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true } as any), 150);
      const cur = pinnedSetting ?? [];
      if (drop?.kind === 'pin') {
        // Commit: upsert into the VISIBLE pinned order at the drop index, then
        // carry any stored entries whose rows aren't materialized right now
        // (e.g. a machine's terminals not loaded yet) — a drag must not
        // silently drop them.
        const visibleKeys = pinnedRows.map((r) => r.key);
        const visible = new Set(visibleKeys);
        const next = upsertPinAt(visibleKeys.map((k) => ({ key: k })), key, drop.index);
        const carried = cur.filter((p) => p.key !== key && !visible.has(p.key));
        const changed =
          next.length + carried.length !== cur.length ||
          [...next, ...carried].some((p, i) => p.key !== cur[i]?.key);
        if (changed) setPinnedSetting([...next, ...carried]);
      } else if (drop?.kind === 'auto' && isPinned(cur, key)) {
        // dragged out of the manual zone → unpin (row returns to activity order)
        setPinnedSetting(cur.filter((p) => p.key !== key));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // Prune pins whose target is gone (deleted session, archived session, dead
  // terminal). Rendering already skips them (splitPinnedRows); this is the
  // periodic write-back so the synced list doesn't accumulate ghosts. A key
  // is only pruned after being missing in TWO consecutive sweeps — guards
  // against transient emptiness while machine/terminal state is still
  // loading (a too-eager prune would sync the loss to every device). The
  // terminal list derives from the machines slice (daemon pushes), so
  // isDataReady is the same load gate for both key kinds.
  const missingPinsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sweep = () => {
      const st = storage.getState();
      if (!st.isDataReady) return;
      const pinned = st.settings.pinnedRows ?? [];
      if (pinned.length === 0) return;
      const valid = new Set<string>();
      for (const s of Object.values(st.sessions)) {
        if (s.active) valid.add(s.id);
      }
      for (const tm of useTerminalSessions.getState().terminals) valid.add(`t:${tm.id}`);
      const missingNow = new Set<string>();
      for (const p of pinned) {
        if (!valid.has(p.key)) missingNow.add(p.key);
      }
      const confirmed = new Set([...missingNow].filter((k) => missingPinsRef.current.has(k)));
      missingPinsRef.current = missingNow;
      if (confirmed.size === 0) return;
      const next = prunePinned(pinned, new Set(pinned.map((p) => p.key).filter((k) => !confirmed.has(k))));
      if (next) sync.applySettings({ pinnedRows: next });
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
  // what's on screen: pinned section first, then the activity list.
  const displayRows = rows === null ? null : [...pinnedRows, ...restRows];
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
            {pinnedRows.length > 0 && (
              <div className="sb-pin-sect">
                <div className="sb-sect-head mono">
                  <Pin size={11} /> {t('sidebar.pinned')}
                </div>
                {pinnedRows.map((r, i) => (
                  <div
                    key={r.key}
                    data-dragkey={r.key}
                    data-pinnedrow="1"
                    className={`sb-drag-item${
                      dragKey === r.key
                        ? dropKind === 'auto'
                          ? ' is-drag is-drop-out' // released here → unpins
                          : ' is-drag'
                        : ''
                    }`}
                    onPointerDown={(e) => onRowPointerDown(e, r.key)}
                  >
                    <SidebarRow
                      row={r}
                      badge={cmdHeld && i < 9 ? i + 1 : undefined}
                      pinned
                      canMoveUp={i > 0}
                      canMoveDown={i < pinnedRows.length - 1}
                      onTogglePin={() => setPinnedSetting(togglePin(pinnedSetting ?? [], r.key))}
                      onMovePin={(dir) => setPinnedSetting(movePin(pinnedSetting ?? [], r.key, dir))}
                      onRenameRequest={() => setRenameTarget(r)}
                    />
                  </div>
                ))}
              </div>
            )}
            {restRows.map((r, i) => {
              const badgeIdx = pinnedRows.length + i;
              return (
                <div
                  key={r.key}
                  data-dragkey={r.key}
                  className={`sb-drag-item${
                    dragKey === r.key
                      ? dropKind === 'auto'
                        ? ' is-drag is-drop-none' // released here → no-op
                        : ' is-drag'
                      : ''
                  }`}
                  onPointerDown={(e) => onRowPointerDown(e, r.key)}
                >
                  <SidebarRow
                    row={r}
                    badge={cmdHeld && badgeIdx < 9 ? badgeIdx + 1 : undefined}
                    onTogglePin={
                      pinsApply ? () => setPinnedSetting(togglePin(pinnedSetting ?? [], r.key)) : undefined
                    }
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
  pinned?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onRename: () => void;
  onTogglePin?: () => void;
  onMovePin?: (dir: -1 | 1) => void;
  onArchiveOrDelete: () => void;
  onDeleteSession?: () => void;
}): MenuItemDef[] {
  const { t } = opts;
  const items: MenuItemDef[] = [
    { key: 'rename', label: t('common.rename'), icon: Pencil, onSelect: opts.onRename },
  ];
  if (opts.onTogglePin) {
    items.push({
      key: 'pin',
      label: opts.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
      icon: opts.pinned ? PinOff : Pin,
      onSelect: opts.onTogglePin,
    });
  }
  if (opts.pinned && opts.onMovePin) {
    const move = opts.onMovePin;
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
  pinned,
  canMoveUp,
  canMoveDown,
  onTogglePin,
  onMovePin,
  onRenameRequest,
}: {
  row: Row;
  badge?: number;
  pinned?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** undefined → pinning not available here (archived view). */
  onTogglePin?: () => void;
  /** Menu fallback for coarse pointers (no touch drag) — pinned rows only. */
  onMovePin?: (dir: -1 | 1) => void;
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
    pinned,
    canMoveUp,
    canMoveDown,
    onRename: onRenameRequest,
    onTogglePin,
    onMovePin,
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
