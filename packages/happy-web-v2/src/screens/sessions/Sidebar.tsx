import { useMemo, useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Search, Plus, Settings, X, TerminalSquare, MoreHorizontal, MessageSquare, PanelLeftClose } from 'lucide-react';
import { useSessions, useAllMachines, storage } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { sessionUpdateTitle, sessionArchive, sessionKill, sessionDelete, machineKillTerminal, machineListTerminals } from '@/sync/ops';
import type { Session } from '@/sync/storageTypes';
import { StatusDot, CyberMark } from '@/ui';
import { Modal } from '@/modal';
import { useSocketStatus, socketToStatus } from '@/app/useConnection';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { useTranslation } from '@/i18n/useTranslation';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { NewSessionModal } from './NewSessionModal';
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
  const reconcileTerminals = useTerminalSessions((s) => s.reconcile);
  const machines = useAllMachines({ includeOffline: true });
  const toggleCollapsed = useSidebarPrefs((s) => s.toggleCollapsed);

  // Reconcile the (client-owned) terminal list against each online machine's
  // REAL live tmux sessions: adopt orphans (created elsewhere / lost records) so
  // they're visible+deletable instead of leaking, and drop dead records.
  //
  // This is also the ONE poll loop for per-terminal Claude agent state: every
  // `machineListTerminals` result is fed to the terminalAgentState store, so we
  // don't run a second competing poller against the same RPC. Runs on mount /
  // online-set change, then every 10s — slowed to 30s while the tab is hidden
  // rather than paused outright, because the needs_input notification only
  // matters while the user is away (a fully paused poll could never fire it).
  const ingestAgentStates = useTerminalAgentStates((s) => s.ingest);
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const onlineMachineIds = useMemo(
    () => machines.filter(isMachineOnline).map((m) => m.id).join(','),
    [machines],
  );
  useEffect(() => {
    if (!onlineMachineIds) return;
    let cancelled = false;
    const poll = () => {
      for (const id of onlineMachineIds.split(',')) {
        const m = machinesRef.current.find((x) => x.id === id);
        const name = (m as any)?.metadata?.displayName || (m as any)?.metadata?.host || id.slice(0, 8);
        machineListTerminals(id).then((live) => {
          if (cancelled) return;
          reconcileTerminals(id, name, live); // null-safe (no-op on failed query)
          if (live) ingestAgentStates(id, live); // failure → keep last known states
        });
      }
    };
    poll();
    let timer: ReturnType<typeof setInterval> | null = null;
    const schedule = () => {
      if (timer) clearInterval(timer);
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      timer = setInterval(poll, hidden ? 30_000 : 10_000);
    };
    schedule();
    const onVisibility = () => {
      schedule();
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineMachineIds]);

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
    if (query.trim()) {
      const q = query.toLowerCase();
      return all.filter((r) => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q));
    }
    return all;
  }, [sessions, terminals, query, filter]);

  // Quick-switch: hold ⌘/Ctrl to reveal 1-9 badges on the first rows; ⌘/Ctrl+digit
  // jumps to that conversation. Mirrors the v1 power-user shortcut.
  const rowsRef = useRef<Row[] | null>(rows);
  rowsRef.current = rows;
  useEffect(() => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      setCmdHeld(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const list = rowsRef.current;
        const target = list?.[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          setCmdHeld(false);
          navigate(rowHref(target));
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
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
          <button className="sb-icon-btn" title={t('sidebar.collapse' as any)} onClick={toggleCollapsed}>
            <PanelLeftClose size={17} />
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="sb-icon-btn" title={t('sidebar.newSession' as any)}>
                <Plus size={18} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="vh-menu" align="end" sideOffset={6}>
                <DropdownMenu.Item className="vh-menu-item" onSelect={() => setShowNew(true)}>
                  <MessageSquare size={15} /> {t('newSessionModal.chatTitle' as any)}
                </DropdownMenu.Item>
                <DropdownMenu.Item className="vh-menu-item" onSelect={() => navigate('/terminal')}>
                  <TerminalSquare size={15} /> {t('newSessionModal.terminalTitle' as any)}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      <div className="sb-search">
        <Search size={15} className="sb-search-icon" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('sidebar.searchPlaceholder' as any)}
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
            {t(`sidebar.filter${f[0].toUpperCase()}${f.slice(1)}` as any)}
          </button>
        ))}
      </div>

      <div className="sb-list">
        {rows === null ? (
          <div className="sb-loading">
            <StatusDot status="thinking" pulse /> {t('common.loading' as any)}
          </div>
        ) : rows.length === 0 ? (
          <div className="sb-empty">{query ? t('sidebar.noResults' as any) : t('newSession.empty' as any)}</div>
        ) : (
          rows.map((r, i) => <SidebarRow key={r.key} row={r} badge={cmdHeld && i < 9 ? i + 1 : undefined} />)
        )}
      </div>

      <footer className="sb-footer">
        <button className="sb-footer-btn" onClick={() => navigate('/settings')}>
          <Settings size={16} /> {t('tabs.settings' as any)}
        </button>
      </footer>

      {showNew && <NewSessionModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

function SidebarRow({ row, badge }: { row: Row; badge?: number }) {
  const navigate = useNavigate();
  const { id } = useParams();
  const location = useLocation();
  const { t } = useTranslation();
  const renameTerminal = useTerminalSessions((s) => s.rename);
  const removeTerminal = useTerminalSessions((s) => s.remove);

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

  const onRename = async () => {
    const next = await Modal.prompt(t('common.rename' as any), undefined, { defaultValue: row.title });
    if (next == null) return;
    if (isTerminal) renameTerminal(row.terminalId!, next);
    else await sessionUpdateTitle(row.session!.id, next).catch(() => {});
  };

  const onArchiveOrDelete = async () => {
    if (isTerminal) {
      // Deleting a terminal destroys its tmux session on the machine — confirm,
      // then kill on the machine AND drop the record (they were out of sync
      // before: removing the record alone orphaned the tmux session forever).
      const ok = await Modal.confirm(t('terminal.deleteTitle' as any), t('terminal.deleteMessage' as any), {
        confirmText: t('common.delete' as any),
        destructive: true,
      });
      if (!ok) return;
      await machineKillTerminal(row.machineId!, row.terminalId!);
      removeTerminal(row.terminalId!);
    } else {
      const ok = await Modal.confirm(t('sidebar.archiveConfirm' as any), undefined, {
        confirmText: t('sidebar.filterArchived' as any),
        destructive: true,
      });
      if (!ok) return;
      // Mirrors happy-app's performArchive. Server-side archive alone doesn't
      // stick for a LIVE session: the still-running CLI keeps reporting itself
      // active and flips the row right back. So: optimistic local flip (row
      // leaves the active list instantly), then kill the CLI process; only if
      // it's already dead force-archive via the server. Roll back on failure.
      const session = row.session!;
      const wasActive = session.active;
      if (wasActive) storage.getState().setSessionActiveLocal(session.id, false);
      try {
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
          await sessionArchive(session.id);
        }
      } catch (error) {
        if (wasActive) storage.getState().setSessionActiveLocal(session.id, true);
        throw error;
      }
    }
  };

  // Permanently delete a session — mirrors happy-app's info-screen flow:
  // confirm, best-effort kill while the CLI is still connected (the server
  // rejects deleting a live session), then DELETE. sessionDelete purges the
  // local copy and tombstones the id, so the kill's straggler update-session
  // can't resurrect the row (deleted-session race).
  const onDeleteSession = async () => {
    const session = row.session!;
    const ok = await Modal.confirm(
      t('sessionInfo.deleteSessionConfirm'),
      t('sessionInfo.deleteSessionWarning'),
      { confirmText: t('common.delete'), destructive: true },
    );
    if (!ok) return;
    if (selected) navigate('/');
    if (session.active || session.presence === 'online') {
      await sessionKill(session.id).catch(() => {});
    }
    const result = await sessionDelete(session.id);
    if (!result.success) {
      Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToDeleteSession'));
    }
  };

  return (
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
          <span className="sb-row-title">{row.title}</span>
          <span className="sb-row-sub mono">{row.subtitle}</span>
        </span>
        {badge != null && <kbd className="sb-row-badge mono">⌘{badge}</kbd>}
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="sb-row-menu" aria-label="actions" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="vh-menu" align="end" sideOffset={4}>
            <DropdownMenu.Item className="vh-menu-item" onSelect={onRename}>
              {t('common.rename' as any)}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="vh-menu-item is-danger" onSelect={onArchiveOrDelete}>
              {isTerminal ? t('common.delete' as any) : t('sidebar.filterArchived' as any)}
            </DropdownMenu.Item>
            {!isTerminal && (
              <DropdownMenu.Item className="vh-menu-item is-danger" onSelect={onDeleteSession}>
                {t('common.delete')}
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
