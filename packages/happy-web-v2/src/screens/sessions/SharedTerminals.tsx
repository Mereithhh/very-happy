/**
 * SharedTerminals (B-878) — terminals other people shared with me, under the
 * session invitations at the top of the sidebar: pending ones with accept /
 * ignore inline, active ones as rows that open `/shared/terminal/:grantId`.
 * Each row also has ⋯ → Leave (touch parity: the same item on the visible ⋯).
 */
import { Check, LogOut, MoreHorizontal, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useIncomingTerminalShares, useTerminalShares } from '@/sync/terminalSharesStore';
import { useTranslation } from '@/i18n/useTranslation';
import { ActionDropdownMenu } from '@/ui';
import { Modal } from '@/modal';
import { toast } from '@/ui/Toast';
import '../session/shared.css';
import '../terminal/terminalShare.css';

export function sharedTerminalPath(grantId: string): string {
    return `/shared/terminal/${encodeURIComponent(grantId)}`;
}

export function SharedTerminals() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const shares = useIncomingTerminalShares();
    const respond = useTerminalShares((s) => s.respond);
    const [busy, setBusy] = useState<string | null>(null);
    if (shares.length === 0) return null;
    const pending = shares.filter((s) => s.status === 'pending');
    const active = shares.filter((s) => s.status === 'active');

    const answer = async (id: string, accept: boolean) => {
        setBusy(id);
        try {
            await respond(id, accept);
            if (accept) navigate(sharedTerminalPath(id));
        } catch {
            toast.error(t('share.invites.failed'));
        } finally {
            setBusy(null);
        }
    };
    const leave = async (id: string, owner: string) => {
        const ok = await Modal.confirm(t('share.terminal.leaveConfirm', { owner }), undefined, { confirmText: t('share.terminal.leave'), destructive: true });
        if (!ok) return;
        await answer(id, false);
        if (location.pathname === sharedTerminalPath(id)) navigate('/');
    };

    return (
        <>
            {pending.length > 0 && (
                <div className="sb-invites" role="list" aria-label={t('share.invites.title')}>
                    {pending.map((share) => {
                        const title = share.title || t('share.terminal.untitled');
                        return (
                            <div key={share.id} className="sb-invite" role="listitem">
                                <div className="sb-invite-head">
                                    <SquareTerminal size={14} aria-hidden />
                                    <span className="sb-invite-line" title={t('share.terminal.invite', { owner: share.owner.displayName, title })}>
                                        {t('share.terminal.invite', { owner: share.owner.displayName, title })}
                                    </span>
                                </div>
                                <span className="sb-invite-sub">{share.role === 'operator' ? t('share.roleOperator') : t('share.roleViewer')}</span>
                                <span className="sb-invite-actions">
                                    <button type="button" className="vh-btn vh-btn--primary vh-btn--sm" disabled={busy === share.id} aria-busy={busy === share.id} onClick={() => void answer(share.id, true)}>
                                        <Check size={14} aria-hidden /> {t('share.invites.accept')}
                                    </button>
                                    <button type="button" className="vh-btn vh-btn--ghost vh-btn--sm" disabled={busy === share.id} onClick={() => void answer(share.id, false)}>
                                        {t('share.invites.decline')}
                                    </button>
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
            {active.length > 0 && (
                <div className="sb-shared-terms" role="list" aria-label={t('share.terminal.sharedGroup')}>
                    <span className="sb-shared-terms-label">{t('share.terminal.sharedGroup')}</span>
                    {active.map((share) => {
                        const path = sharedTerminalPath(share.id);
                        const title = share.title || t('share.terminal.untitled');
                        const sub = [share.owner.displayName, share.role === 'operator' ? t('share.roleOperator') : t('share.roleViewer'), share.cwd, share.alive === false ? t('share.terminal.notRunning') : null].filter(Boolean).join(' · ');
                        return (
                            <div key={share.id} className="sb-shared-term-row" role="listitem">
                                <Link to={path} className="sb-shared-term" aria-current={location.pathname === path ? 'page' : undefined}>
                                    <SquareTerminal size={15} aria-hidden />
                                    <span className="sb-shared-term-text">
                                        <span className="sb-shared-term-name">{title}</span>
                                        <span className="sb-shared-term-sub">{sub}</span>
                                    </span>
                                </Link>
                                <ActionDropdownMenu items={[{ key: 'leave', label: t('share.terminal.leave'), icon: LogOut, danger: true, onSelect: () => void leave(share.id, share.owner.displayName) }]}>
                                    <button type="button" className="sb-icon-btn sb-shared-term-more" aria-label={t('terminal.moreActions')}>
                                        <MoreHorizontal size={16} />
                                    </button>
                                </ActionDropdownMenu>
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
