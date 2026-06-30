import { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Search, Plus, Settings, X, TerminalSquare, MoreHorizontal, MessageSquare, PanelLeftClose } from 'lucide-react';
import { useSessions } from '@/sync/storage';
import { getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { sessionUpdateTitle, sessionArchive } from '@/sync/ops';
import type { Session } from '@/sync/storageTypes';
import { StatusDot, CyberMark } from '@/ui';
import { Modal } from '@/modal';
import { useSocketStatus, socketToStatus } from '@/app/useConnection';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { useTranslation } from '@/i18n/useTranslation';
import { useTerminalSessions } from '@/sync/terminalSessions';
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
  const toggleCollapsed = useSidebarPrefs((s) => s.toggleCollapsed);

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
  const { t } = useTranslation();
  const renameTerminal = useTerminalSessions((s) => s.rename);
  const removeTerminal = useTerminalSessions((s) => s.remove);

  const isTerminal = row.kind === 'terminal';
  const selected = isTerminal ? false : id === row.session!.id;
  const s = row.session;

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
      removeTerminal(row.terminalId!);
    } else {
      const ok = await Modal.confirm(t('sidebar.archiveConfirm' as any), undefined, {
        confirmText: t('sidebar.filterArchived' as any),
        destructive: true,
      });
      if (ok) await sessionArchive(row.session!.id).catch(() => {});
    }
  };

  return (
    <div className={`sb-row${selected ? ' is-selected' : ''}`}>
      <button className="sb-row-main" onClick={open}>
        <span className={`sb-row-icon${isTerminal ? ' sb-row-icon--term' : ''}`}>
          {isTerminal ? <TerminalSquare size={16} /> : <StatusDot status={dot} pulse={dot === 'thinking'} size={9} />}
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
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
