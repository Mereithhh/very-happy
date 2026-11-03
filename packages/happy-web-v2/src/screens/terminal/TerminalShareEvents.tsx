/** B-878: a terminal grant's activity log for the owner (metadata only — never keystrokes). */
import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { SessionShareApiError } from '@/sync/apiSessionShares';
import { listTerminalGrantEvents } from '@/sync/apiTerminalShares';
import type { TerminalShareEvent } from '@/sync/terminalShareTypes';
import { formatShareTime } from '@/screens/session/shareFormat';
import { terminalShareEventLabelKey } from './terminalShareEventLabels';

export function TerminalShareEventsList({ grantId, actorName }: { grantId: string; actorName: string }) {
    const { t } = useTranslation();
    const [events, setEvents] = useState<TerminalShareEvent[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        listTerminalGrantEvents(grantId)
            .then((list) => { if (alive) setEvents(list); })
            .catch((e) => { if (alive) setError(e instanceof SessionShareApiError && e.code === 'http_404' ? t('share.terminal.errors.serverTooOld') : t('share.operator.eventsFailed')); });
        return () => { alive = false; };
    }, [grantId, t]);
    if (error) return <p className="shd-error" role="alert">{error}</p>;
    if (!events) return <p className="shd-empty">{t('common.loading')}</p>;
    if (events.length === 0) return <p className="shd-empty">{t('share.operator.eventsEmpty')}</p>;
    return (
        <ol className="shd-opevents">
            {events.map((event) => (
                <li key={event.id}>
                    <span className="shd-opevents-time">{formatShareTime(event.at)}</span>
                    <span className="shd-opevents-text">
                        {actorName && event.kind.startsWith('terminal.') ? `${actorName} · ` : ''}{t(terminalShareEventLabelKey(event.kind))}
                        {event.kind === 'terminal.input' && event.detail && typeof event.detail.bytes === 'number'
                            ? <span className="shd-opevents-detail"> {`${event.detail.bytes} B`}</span> : null}
                    </span>
                </li>
            ))}
        </ol>
    );
}
