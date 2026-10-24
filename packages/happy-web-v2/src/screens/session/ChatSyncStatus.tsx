/**
 * B-804: the thin line at the bottom of the chat while the viewed session's
 * messages catch up (sync/catchUpStatus.ts) — 「同步消息中…」 after 300ms,
 * 「连接不稳定 · 重试」 once the catch-up outlived the request deadline.
 * Nothing shows for a catch-up that lands sooner.
 */
import { RefreshCw, WifiOff } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useCatchUpPhase } from '@/sync/catchUpStatus';
import { sync } from '@/sync/sync';

export function ChatSyncStatus({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const phase = useCatchUpPhase(sessionId);
    if (!phase) return null;
    return <div className={`chat-sync chat-sync--${phase}`} role="status" aria-live="polite" data-sync-phase={phase}>
        {phase === 'slow'
            ? <>
                <WifiOff size={12} aria-hidden />
                <span>{t('network.unstable')}</span>
                <span className="chat-sync-sep" aria-hidden>·</span>
                <button type="button" className="chat-sync-retry" onClick={() => sync.retryMessagesCatchUp(sessionId)}>{t('common.retry')}</button>
            </>
            : <>
                <RefreshCw className="chat-sync-icon" size={12} aria-hidden />
                <span>{t('network.syncingMessages')}</span>
            </>}
    </div>;
}
