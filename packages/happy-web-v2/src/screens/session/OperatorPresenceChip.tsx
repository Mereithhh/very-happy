/**
 * B-867 owner side — 「X 正在操作 · 终端 N」 in the session header. Loud on
 * purpose (danger token, not the live accent): someone else holds a shell on
 * this machine. Click → recent activity + a one-click 「结束对方的操作」
 * (= PATCH operate:false: removes the tier, disconnects them and kills the
 * terminals they opened; they keep "Can send").
 *
 * Fed by GET operator-activity on mount and the `operator-activity` socket
 * event; re-evaluated every 30 s so the two-minute "recently active" window
 * closes by itself. An old server answers 404 → the chip never shows.
 */
import * as Popover from '@radix-ui/react-popover';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getOperatorActivity, SessionShareApiError } from '@/sync/apiSessionShares';
import { onOperatorEvent } from '@/sync/operatorTransport';
import { isOperatingNow, type OperatorActivity } from '@/sync/sessionShareTypes';
import { useSessionShares } from '@/sync/sessionSharesStore';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { OperatorEventsList } from './OperatorGrant';
import './shared.css';

/** Merge one activity frame into the list (replace by grantee). Pure; tested. */
export function mergeOperatorActivity(list: OperatorActivity[], next: OperatorActivity): OperatorActivity[] {
    const rest = list.filter((a) => a.granteeAccountId !== next.granteeAccountId);
    return [...rest, next];
}

export function OperatorPresenceChip({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
    const { t } = useTranslation();
    const [activity, setActivity] = useState<OperatorActivity[]>([]);
    const [now, setNow] = useState(() => Date.now());
    const setOperate = useSessionShares((s) => s.setOperate);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        getOperatorActivity(sessionId)
            .then((list) => { if (alive) setActivity(list); })
            .catch((e) => { if (!(e instanceof SessionShareApiError)) return; /* 404 = old server or no operators */ });
        const off = onOperatorEvent('activity', (e) => {
            if (e.sessionId !== sessionId) return;
            const { sessionId: _ignored, ...rest } = e;
            setActivity((list) => mergeOperatorActivity(list, rest));
            setNow(Date.now());
        });
        const tick = setInterval(() => setNow(Date.now()), 30_000);
        return () => { alive = false; off(); clearInterval(tick); };
    }, [sessionId]);

    const live = activity.filter((a) => isOperatingNow(a, now));
    if (live.length === 0) return null;

    const end = async (accountId: string) => {
        setBusy(true); setError(null);
        try {
            await setOperate(sessionId, accountId, false);
            setActivity((list) => list.filter((a) => a.granteeAccountId !== accountId));
            setConfirming(null);
        } catch (e) {
            setError(t('share.operator.endFailed', { error: e instanceof SessionShareApiError ? e.code : 'unknown' }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {live.map((a) => (
                <Popover.Root key={a.granteeAccountId} onOpenChange={(open) => { if (!open) { setConfirming(null); setError(null); } }}>
                    <Popover.Trigger asChild>
                        <button type="button" className={`opchip${compact ? ' opchip--compact' : ''}`} title={t('share.operator.chipTitle')} aria-label={t('share.operator.chip', { name: a.displayName, count: a.openTerminals })}>
                            <ShieldAlert size={13} aria-hidden />
                            <span className="opchip-text">{t('share.operator.chip', { name: a.displayName, count: a.openTerminals })}</span>
                        </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Content className="opchip-pop" align="end" sideOffset={6} collisionPadding={12}>
                            <p className="opchip-pop-title">{t('share.operator.chip', { name: a.displayName, count: a.openTerminals })}</p>
                            <p className="opchip-pop-sub">{t('share.operator.chipRecent')}</p>
                            <OperatorEventsList sessionId={sessionId} accountId={a.granteeAccountId} actorName={a.displayName} />
                            {error && <p className="shd-error" role="alert">{error}</p>}
                            {confirming === a.granteeAccountId ? (
                                <div className="opchip-confirm" role="group">
                                    <p className="opchip-confirm-text">{t('share.operator.endConfirm', { name: a.displayName })}</p>
                                    <div className="opchip-actions">
                                        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
                                        <Button type="button" variant="danger" size="sm" loading={busy} onClick={() => void end(a.granteeAccountId)}>{t('share.operator.endOperation')}</Button>
                                    </div>
                                </div>
                            ) : (
                                <Button type="button" variant="danger" size="sm" onClick={() => setConfirming(a.granteeAccountId)}>{t('share.operator.endOperation')}</Button>
                            )}
                        </Popover.Content>
                    </Popover.Portal>
                </Popover.Root>
            ))}
        </>
    );
}
