/**
 * SharedSessionBanner (B-619) — the strip under the header of a session that
 * was shared WITH me. Says whose session it is, what I may do, and that
 * permissions / interrupts stay with the owner. Quiet metadata, no accent.
 */
import { Users } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { sessionAccess } from '@/app/sessionAccess';
import { formatShareTime } from './shareFormat';
import './shared.css';

export function SharedSessionBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const share = session?.share;
    if (!share) return null;
    const access = sessionAccess(session);
    return (
        <div className="shb" role="status">
            <Users size={14} aria-hidden />
            <span className="shb-text shb-text--full">
                {access === 'operator'
                    ? t('share.operator.banner', { owner: share.owner.displayName, expiry: share.expiresAt ? formatShareTime(share.expiresAt) : '—' })
                    : access === 'driver'
                    ? t('share.banner.driver', { owner: share.owner.displayName })
                    : t('share.banner.viewer', { owner: share.owner.displayName })}
            </span>
            {/* phones: one line — the role chip already says what I may do */}
            <span className="shb-text shb-text--short">{t('share.banner.short', { owner: share.owner.displayName })}</span>
            <span className={`shb-role${access === 'operator' ? ' shb-role--operator' : ''}`}>{access === 'operator' ? t('share.roleOperator') : access === 'driver' ? t('share.roleDriver') : t('share.roleViewer')}</span>
        </div>
    );
}
