/**
 * B-516: optimistic new sessions that have not landed yet — starting,
 * waiting for a directory confirmation, or failed — so a user who left the
 * pending page can find their text again. A landing record disappears from
 * here: its real session row takes over.
 */
import { useLocation, useNavigate } from 'react-router-dom';
import { CircleAlert, MessageSquare, X } from 'lucide-react';
import { Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { pendingSessions, usePendingList } from '@/sync/pendingSessionsRuntime';

function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function PendingSessionRows() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const rows = usePendingList().filter((r) => r.state === 'spawning' || r.state === 'needs-approval' || r.state === 'failed');
    if (rows.length === 0) return null;
    return (
        <div className="sb-section sb-pending-section" data-pending-rows>
            {rows.map((r) => {
                const href = `/session/${r.pendingId}`;
                const selected = location.pathname === href;
                const status = r.state === 'failed'
                    ? t('pendingSession.sidebarFailed')
                    : r.state === 'needs-approval'
                        ? t('pendingSession.sidebarNeedsApproval')
                        : t('pendingSession.sidebarStarting');
                const title = basename(r.path) || t('newSessionModal.chatTitle');
                return (
                    <div key={r.pendingId} className={`sb-row${selected ? ' is-selected' : ''}`} data-pending-state={r.state}>
                        <button
                            type="button"
                            className="sb-row-main"
                            aria-current={selected ? 'page' : undefined}
                            title={`${title} · ${status}`}
                            onClick={() => navigate(href)}
                        >
                            <span className="sb-row-icon sb-row-icon--neutral"><MessageSquare size={15} /></span>
                            <span className="sb-row-text">
                                <span className="sb-row-title-line"><span className="sb-row-title">{title}</span></span>
                                <span className="sb-row-sub mono">{status} · {r.path}</span>
                            </span>
                            <span className={`sb-row-status${r.state === 'spawning' ? '' : ' sb-row-status--input'}`} role="img" aria-label={status}>
                                {r.state === 'spawning' ? <Spinner size={14} /> : <CircleAlert size={14} />}
                            </span>
                        </button>
                        {r.state !== 'spawning' && (
                            <button
                                type="button"
                                className="sb-closed-reopen"
                                aria-label={t('common.discard')}
                                title={t('common.discard')}
                                onClick={() => {
                                    if (pendingSessions.discard(r.pendingId) && selected) navigate('/');
                                }}
                            ><X size={15} /></button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
