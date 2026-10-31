import { GitFork } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useSession } from '@/sync/storage';
import { messageActionsCopy } from './messageActionsCopy';

/**
 * B-851: under the header of a forked session — 「分叉自 〈原会话标题〉」, the
 * title links back to the source. A source this device has not loaded (or
 * that was deleted) falls back to 「返回原会话」.
 */
export function ForkOrigin({ parentSessionId }: { parentSessionId: string }) {
    const { t, lang } = useTranslation();
    const parent = useSession(parentSessionId);
    const title = parent ? parent.metadata?.summary?.text?.trim() || t('session.newChat') : messageActionsCopy(lang).parent;
    return <div className="msg-branch-context">
        <GitFork size={14} aria-hidden />
        <span>{t('session.forkedFromLabel')}</span>
        <Link className="msg-parent-link" to={`/session/${encodeURIComponent(parentSessionId)}`} title={t('session.forkedFromSubtitle')}>{title}</Link>
    </div>;
}
