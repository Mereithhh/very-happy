/**
 * SharedInvites (B-619) — sessions other people shared with me that I have
 * not answered yet. Lives at the top of the sidebar list: one line per
 * invitation, accept / ignore inline. Accepting lands the session in the
 * 「分享给我的」 group and opens it.
 */
import { Check, Users, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useSessionInvites, useSessionShares } from '@/sync/sessionSharesStore';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui/Toast';
import '../session/shared.css';

export function SharedInvites() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const invites = useSessionInvites();
    const accept = useSessionShares((s) => s.accept);
    const decline = useSessionShares((s) => s.decline);
    const [busy, setBusy] = useState<string | null>(null);
    if (invites.length === 0) return null;

    const onAccept = async (id: string, sessionId: string) => {
        setBusy(id);
        try {
            await accept(id);
            await sync.refreshSessions();
            navigate(`/session/${encodeURIComponent(sessionId)}`);
        } catch {
            toast.error(t('share.invites.failed'));
        } finally {
            setBusy(null);
        }
    };
    const onDecline = async (id: string) => {
        setBusy(id);
        try { await decline(id); } catch { toast.error(t('share.invites.failed')); } finally { setBusy(null); }
    };

    return (
        <div className="sb-invites" role="list" aria-label={t('share.invites.title')}>
            {invites.map((invite) => {
                const name = invite.session.name ?? t('session.newChat');
                const sub = [invite.session.host, invite.session.path].filter(Boolean).join(' · ');
                return (
                    <div key={invite.id} className="sb-invite" role="listitem">
                        <Users size={15} aria-hidden />
                        <span className="sb-invite-text">
                            <span className="sb-invite-line" title={`${invite.owner.displayName} · ${name}`}>
                                <strong>{invite.owner.displayName}</strong> {t('share.invites.shared')} {name}
                            </span>
                            <span className="sb-invite-sub">{[invite.role === 'driver' ? t('share.roleDriver') : t('share.roleViewer'), sub].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="sb-invite-actions">
                            <button type="button" className="vh-btn vh-btn--primary vh-btn--sm" disabled={busy === invite.id} aria-busy={busy === invite.id} onClick={() => void onAccept(invite.id, invite.sessionId)} aria-label={t('share.invites.accept')}>
                                <Check size={14} aria-hidden /> {t('share.invites.accept')}
                            </button>
                            <button type="button" className="vh-btn vh-btn--ghost vh-btn--sm" disabled={busy === invite.id} onClick={() => void onDecline(invite.id)} aria-label={t('share.invites.decline')} title={t('share.invites.decline')}>
                                <X size={14} aria-hidden />
                            </button>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
