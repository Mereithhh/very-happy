/**
 * SharedProjects (B-878 PR-B) — projects other people shared with me, at the
 * top of the sidebar next to shared terminals: a pending one has accept /
 * ignore inline, an active one is a row opening `/shared/project/:grantId`
 * (its sessions also appear there, not in the 「分享给我的」 session group).
 */
import { Check, FolderKanban, LogOut, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useIncomingProjectShares, useProjectShares } from '@/sync/projectSharesStore';
import { useTranslation } from '@/i18n/useTranslation';
import { ActionDropdownMenu } from '@/ui';
import { Modal } from '@/modal';
import { toast } from '@/ui/Toast';
import { sharedProjectPath } from '../projects/SharedProjectScreen';
import '../session/shared.css';
import '../terminal/terminalShare.css';

export function SharedProjects() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const shares = useIncomingProjectShares();
    const respond = useProjectShares((s) => s.respond);
    const [busy, setBusy] = useState<string | null>(null);
    if (shares.length === 0) return null;
    const pending = shares.filter((s) => s.status === 'pending');
    const active = shares.filter((s) => s.status === 'active');
    const answer = async (id: string, accept: boolean) => {
        setBusy(id);
        try {
            await respond(id, accept);
            if (accept) navigate(sharedProjectPath(id));
        } catch {
            toast.error(t('share.invites.failed'));
        } finally {
            setBusy(null);
        }
    };
    const leave = async (id: string, owner: string) => {
        const ok = await Modal.confirm(t('share.project.leaveConfirm', { owner }), undefined, { confirmText: t('share.project.leave'), destructive: true });
        if (!ok) return;
        await answer(id, false);
        if (location.pathname === sharedProjectPath(id)) navigate('/');
    };
    return (
        <>
            {pending.length > 0 && (
                <div className="sb-invites" role="list" aria-label={t('share.invites.title')}>
                    {pending.map((share) => (
                        <div key={share.id} className="sb-invite" role="listitem">
                            <div className="sb-invite-head">
                                <FolderKanban size={14} aria-hidden />
                                <span className="sb-invite-line" title={t('share.project.invite', { owner: share.owner.displayName, name: share.name })}>{t('share.project.invite', { owner: share.owner.displayName, name: share.name })}</span>
                            </div>
                            <span className="sb-invite-sub">{share.role === 'driver' ? t('share.roleDriver') : t('share.roleViewer')}</span>
                            <span className="sb-invite-actions">
                                <button type="button" className="vh-btn vh-btn--primary vh-btn--sm" disabled={busy === share.id} aria-busy={busy === share.id} onClick={() => void answer(share.id, true)}>
                                    <Check size={14} aria-hidden /> {t('share.invites.accept')}
                                </button>
                                <button type="button" className="vh-btn vh-btn--ghost vh-btn--sm" disabled={busy === share.id} onClick={() => void answer(share.id, false)}>{t('share.invites.decline')}</button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {active.length > 0 && (
                <div className="sb-shared-terms" role="list" aria-label={t('share.project.sharedGroup')}>
                    <span className="sb-shared-terms-label">{t('share.project.sharedGroup')}</span>
                    {active.map((share) => {
                        const path = sharedProjectPath(share.id);
                        return (
                            <div key={share.id} className="sb-shared-term-row" role="listitem">
                                <Link to={path} className="sb-shared-term" aria-current={location.pathname === path ? 'page' : undefined}>
                                    <FolderKanban size={15} aria-hidden />
                                    <span className="sb-shared-term-text">
                                        <span className="sb-shared-term-name">{share.name}</span>
                                        <span className="sb-shared-term-sub">{[share.owner.displayName, share.role === 'driver' ? t('share.roleDriver') : t('share.roleViewer')].join(' · ')}</span>
                                    </span>
                                </Link>
                                <ActionDropdownMenu items={[{ key: 'leave', label: t('share.project.leave'), icon: LogOut, danger: true, onSelect: () => void leave(share.id, share.owner.displayName) }]}>
                                    <button type="button" className="sb-icon-btn sb-shared-term-more" aria-label={t('terminal.moreActions')}><MoreHorizontal size={16} /></button>
                                </ActionDropdownMenu>
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
