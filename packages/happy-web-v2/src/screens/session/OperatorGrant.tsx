/**
 * B-867 operator tier — the owner-side pieces of the share dialog: the warning
 * (form + confirm), the second confirmation, the finite-expiry picker and the
 * per-grant activity log. Spec specs/2026-11-session-sharing-operator.md §9.
 *
 * Copy is deliberately exhaustive (Lead review): the grantee can read every
 * file including Very Happy account credentials, can run any command as the
 * owner, and background processes survive a revoke. No softer summary.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Checkbox } from '@/ui';
import { SelectMenu } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import type { SimpleTranslationKey } from '@/text';
import { listOperatorEvents, SessionShareApiError } from '@/sync/apiSessionShares';
import { OPERATOR_EXPIRY_CHOICES, type OperatorEvent, type ShareExpiryDays } from '@/sync/sessionShareTypes';
import { expiryLabel, formatShareTime } from './shareFormat';
import './shared.css';

type OperatorExpiry = Exclude<ShareExpiryDays, null>;

export const OPERATOR_DEFAULT_EXPIRY: OperatorExpiry = 1;

/** Coerce any expiry choice into one the operator tier allows (no "never"). Pure. */
export function operatorExpiryOf(value: ShareExpiryDays): OperatorExpiry {
    return value && (OPERATOR_EXPIRY_CHOICES as number[]).includes(value) ? value : OPERATOR_DEFAULT_EXPIRY;
}

const EVENT_LABEL: Record<string, SimpleTranslationKey> = {
    'grant.operator': 'share.operator.event.grantOperator',
    'grant.operator.removed': 'share.operator.event.grantOperatorRemoved',
    'terminal.open': 'share.operator.event.terminalOpen',
    'terminal.attach': 'share.operator.event.terminalAttach',
    'terminal.close': 'share.operator.event.terminalClose',
    'terminal.kill': 'share.operator.event.terminalKill',
    'terminal.input': 'share.operator.event.terminalInput',
    permission: 'share.operator.event.permission',
    abort: 'share.operator.event.abort',
    steer: 'share.operator.event.steer',
    mode: 'share.operator.event.mode',
    model: 'share.operator.event.model',
    btw: 'share.operator.event.btw',
    'file.write': 'share.operator.event.fileWrite',
    'file.upload': 'share.operator.event.fileUpload',
    bash: 'share.operator.event.bash',
};

export function operatorEventLabelKey(kind: string): SimpleTranslationKey {
    return EVENT_LABEL[kind] ?? 'share.operator.event.other';
}

/** One short, non-sensitive detail per event: a path, a tool, a mode. Never input text. */
function eventDetail(event: OperatorEvent): string | null {
    const d = event.detail ?? {};
    for (const key of ['path', 'tool', 'mode', 'model', 'reason', 'decision'] as const) {
        const v = d[key];
        if (typeof v === 'string' && v) return v.length > 80 ? `${v.slice(0, 77)}…` : v;
    }
    return null;
}

export function OperatorWarning({ compact }: { compact?: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="shd-opwarn" role="note">
            <p className="shd-opwarn-title"><ShieldAlert size={15} aria-hidden />{t('share.operator.warningTitle')}</p>
            <ul className="shd-opwarn-list">
                <li>{t('share.operator.warningRead')}</li>
                <li>{t('share.operator.warningRun')}</li>
                <li>{t('share.operator.warningBackground')}</li>
                {!compact && <li>{t('share.operator.warningCwd')}</li>}
            </ul>
        </div>
    );
}

export function OperatorExpirySelect({ value, onChange, labelledBy }: { value: OperatorExpiry; onChange: (v: OperatorExpiry) => void; labelledBy?: string }) {
    const { t } = useTranslation();
    return (
        <SelectMenu
            className="shd-expiry"
            label={t('share.expiry.label')}
            labelledBy={labelledBy}
            value={String(value)}
            onChange={(v) => onChange(Number(v) as OperatorExpiry)}
            options={OPERATOR_EXPIRY_CHOICES.map((c) => ({ value: String(c), label: expiryLabel(t, c) }))}
        />
    );
}

/**
 * The second confirmation. `needsAck` = the owner has not ticked the
 * acknowledgement yet (upgrading an existing row); the new-share form ticks
 * it inline first. The grant button never answers Enter-by-default: it is a
 * destructive-class confirmation (design §6).
 */
export function OperatorConfirmDialog({ open, name, host, expiry, onExpiry, needsAck, busy, error, onCancel, onConfirm }: {
    open: boolean;
    name: string;
    host: string | null;
    expiry: OperatorExpiry;
    onExpiry?: (v: OperatorExpiry) => void;
    needsAck: boolean;
    busy: boolean;
    error: string | null;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const { t } = useTranslation();
    const [ack, setAck] = useState(!needsAck);
    useEffect(() => { if (open) setAck(!needsAck); }, [open, needsAck]);
    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
                <Dialog.Content className="vh-dialog so-dialog shd-opconfirm" role="alertdialog" aria-describedby={undefined}>
                    <div className="vh-dialog-head so-head">
                        <Dialog.Title className="vh-dialog-title so-title">{t('share.operator.confirmTitle')}</Dialog.Title>
                        <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                    </div>
                    <ul className="shd-opconfirm-facts">
                        <li>{t('share.operator.confirmWho', { name })}</li>
                        {host && <li>{t('share.operator.confirmMachine', { host })}</li>}
                        {onExpiry ? (
                            <li className="shd-opconfirm-expiry">
                                <span id="shd-op-confirm-exp">{t('share.expiry.label')}</span>
                                <OperatorExpirySelect labelledBy="shd-op-confirm-exp" value={expiry} onChange={onExpiry} />
                            </li>
                        ) : (
                            <li>{t('share.operator.confirmExpiry', { expiry: expiryLabel(t, expiry) })}</li>
                        )}
                    </ul>
                    <OperatorWarning />
                    {needsAck && (
                        <Checkbox className="shd-opack" checked={ack} onCheckedChange={setAck}>{t('share.operator.acknowledge')}</Checkbox>
                    )}
                    {error && <p className="shd-error" role="alert">{error}</p>}
                    <div className="vh-dialog-foot">
                        <Button type="button" variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
                        <Button type="button" variant="danger" size="md" loading={busy} disabled={!ack} onClick={onConfirm}>{t('share.operator.confirmGrant')}</Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

export function OperatorEventsList({ sessionId, accountId, actorName }: { sessionId: string; accountId: string; actorName: string }) {
    const { t } = useTranslation();
    const [events, setEvents] = useState<OperatorEvent[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        listOperatorEvents(sessionId, accountId)
            .then((list) => { if (alive) setEvents(list); })
            .catch((e) => { if (alive) setError(e instanceof SessionShareApiError && e.code === 'http_404' ? t('share.operator.errors.serverTooOld') : t('share.operator.eventsFailed')); });
        return () => { alive = false; };
    }, [sessionId, accountId, t]);
    if (error) return <p className="shd-error" role="alert">{error}</p>;
    if (!events) return <p className="shd-empty">{t('common.loading')}</p>;
    if (events.length === 0) return <p className="shd-empty">{t('share.operator.eventsEmpty')}</p>;
    return (
        <ol className="shd-opevents">
            {events.map((event) => {
                const detail = eventDetail(event);
                return (
                    <li key={event.id}>
                        <span className="shd-opevents-time">{formatShareTime(event.at)}</span>
                        <span className="shd-opevents-text">
                            {event.actorAccountId === accountId ? `${actorName} · ` : ''}{t(operatorEventLabelKey(event.kind))}
                            {detail && <span className="shd-opevents-detail"> {detail}</span>}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}
