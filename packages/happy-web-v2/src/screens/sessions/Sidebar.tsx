import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, Plus, Settings, X, TerminalSquare } from 'lucide-react';
import { useSessions } from '@/sync/storage';
import { getSessionName, getSessionSubtitle, useSessionStatus } from '@/utils/sessionUtils';
import type { Session } from '@/sync/storageTypes';
import { StatusDot, EmptyState, Button } from '@/ui';
import { useSocketStatus, socketToStatus } from '@/app/useConnection';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberMark } from '@/ui';
import { useTerminalSessions } from '@/sync/terminalSessions';
import './sidebar.css';

export function Sidebar() {
  const navigate = useNavigate();
  const sessions = useSessions();
  const socket = useSocketStatus();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const terminals = useTerminalSessions((s) => s.terminals);

  const filtered = useMemo(() => {
    if (!sessions) return null;
    const rows = sessions.filter((s): s is Session => typeof s !== 'string');
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter(
      (s) => getSessionName(s).toLowerCase().includes(q) || getSessionSubtitle(s).toLowerCase().includes(q),
    );
  }, [sessions, query]);

  return (
    <div className="sb">
      <header className="sb-header">
        <div className="sb-brand">
          <CyberMark size={22} />
          <span className="sb-title">very happy</span>
        </div>
        <div className="sb-header-right">
          <StatusDot status={socketToStatus(socket)} pulse={socket === 'connecting'} title={socket} />
          <button className="sb-icon-btn" title={t('sidebar.newSession' as any)} onClick={() => navigate('/terminal')}>
            <Plus size={18} />
          </button>
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

      <div className="sb-list">
        {terminals.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-title eyebrow">Terminals</div>
            {terminals.map((term) => (
              <button
                key={term.id}
                className="sb-row"
                onClick={() => navigate(`/terminal/${term.machineId}?tid=${term.id}`)}
              >
                <span className="sb-row-icon sb-row-icon--term">
                  <TerminalSquare size={16} />
                </span>
                <span className="sb-row-text">
                  <span className="sb-row-title">{term.title || term.machineName}</span>
                  <span className="sb-row-sub mono">{term.machineName}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {filtered === null ? (
          <div className="sb-loading">
            <StatusDot status="thinking" pulse /> {t('common.loading' as any)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            title={query ? t('sidebar.noResults' as any) : t('newSession.empty' as any)}
            description={undefined}
          />
        ) : (
          <div className="sb-section">
            {filtered.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        )}
      </div>

      <footer className="sb-footer">
        <button className="sb-footer-btn" onClick={() => navigate('/settings')}>
          <Settings size={16} /> {t('tabs.settings' as any)}
        </button>
      </footer>
    </div>
  );
}

function SessionRow({ session }: { session: Session }) {
  const navigate = useNavigate();
  const { id } = useParams();
  const status = useSessionStatus(session);
  const name = getSessionName(session);
  const subtitle = getSessionSubtitle(session);
  const selected = id === session.id;

  const dotStatus =
    status.state === 'permission_required'
      ? 'permission'
      : session.thinking
        ? 'thinking'
        : session.presence === 'online'
          ? 'connected'
          : 'offline';

  return (
    <button
      className={`sb-row${selected ? ' is-selected' : ''}`}
      onClick={() => navigate(`/session/${session.id}`)}
    >
      <span className="sb-row-icon">
        <StatusDot status={dotStatus} pulse={session.thinking} size={9} />
      </span>
      <span className="sb-row-text">
        <span className="sb-row-title">{name}</span>
        <span className="sb-row-sub mono">{subtitle}</span>
      </span>
    </button>
  );
}
