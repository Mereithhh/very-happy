/**
 * TerminalShareDialog (B-878) — the owner shares ONE web terminal with one
 * person: view only (live output + scrollback, never types or resizes) or can
 * operate (types too). Same form language as the session ShareDialog: friends
 * first, then a typed email / username; the tier picks the rules:
 *
 *  - view only: a plain notice (not a red warning) that everything the
 *    terminal prints is visible, secrets included; 1/7/30 days (default 7).
 *  - can operate: the B-867 red warning, an inline acknowledgement and a
 *    second confirmation; 1/7/30 days (default 1).
 *
 * Every tier expires (Lead 11-03). Revoking cuts the person off at once; the
 * terminal itself keeps running.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAcceptedFriends } from '@/sync/storage';
import { getDisplayName } from '@/sync/friendTypes';
import { SessionShareApiError } from '@/sync/apiSessionShares';
import { useTerminalShares, useTerminalWatchers } from '@/sync/terminalSharesStore';
import { defaultTerminalShareExpiry, type TerminalGrantView, type TerminalShareExpiry, type TerminalShareRole } from '@/sync/terminalShareTypes';
import { Button, Checkbox, Input } from '@/ui';
import { SelectMenu } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import { shareErrorCopy } from '@/screens/session/ShareDialog';
import { OperatorConfirmDialog, OperatorExpirySelect, OperatorWarning } from '@/screens/session/OperatorGrant';
import { remainingDaysLabel } from '@/screens/session/shareFormat';
import { TerminalShareEventsList } from './TerminalShareEvents';
import '@/screens/session/sessionOptionsDialog.css';
import '@/screens/session/shared.css';
import './terminalShare.css';

type T = ReturnType<typeof useTranslation>['t'];

function errorCopy(t: T, e: unknown): string {
    const code = e instanceof SessionShareApiError ? e.code : 'unknown';
    if (code === 'machine_not_found') return t('share.terminal.ownerOnly');
    if (code === 'machine_unsupported') return t('share.terminal.errors.upgrade');
    if (code === 'bad_expiry') return t('share.operator.expiryRequired');
    return shareErrorCopy(t, code);
}

function initials(name: string): string {
    return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function TerminalShareDialog({ machineId, terminalId, title, host, open, onOpenChange }: {
    machineId: string;
    terminalId: string;
    title: string;
    host: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { t } = useTranslation();
    const key = `${machineId}:${terminalId}`;
    const grants = useTerminalShares((s) => s.grantsByTerminal[key]);
    const refreshGrants = useTerminalShares((s) => s.refreshGrants);
    const share = useTerminalShares((s) => s.share);
    const update = useTerminalShares((s) => s.update);
    const revoke = useTerminalShares((s) => s.revoke);
    const watchers = useTerminalWatchers(machineId, terminalId);
    const friends = useAcceptedFriends();
    const grantedIds = new Set((grants ?? []).map((g) => g.grantee.id));
    const pickable = friends.filter((f) => !grantedIds.has(f.id));

    const [target, setTarget] = useState('');
    const [role, setRole] = useState<TerminalShareRole>('viewer');
    const [expiry, setExpiry] = useState<TerminalShareExpiry>(defaultTerminalShareExpiry('viewer'));
    const [operatorAck, setOperatorAck] = useState(false);
    const [pendingOperator, setPendingOperator] = useState<{ kind: 'new'; who: { target: string } | { accountId: string }; name: string } | { kind: 'upgrade'; grant: TerminalGrantView } | null>(null);
    const [confirmBusy, setConfirmBusy] = useState(false);
    const [confirmError, setConfirmError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
    const [eventsOpen, setEventsOpen] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null); setListError(null); setConfirmRevoke(null); setPendingOperator(null); setOperatorAck(false);
        refreshGrants(machineId, terminalId).catch((e) => setListError(errorCopy(t, e)));
    }, [open, machineId, terminalId, refreshGrants, t]);

    const pickRole = (next: TerminalShareRole) => {
        setRole(next);
        setExpiry(defaultTerminalShareExpiry(next));
        setOperatorAck(false);
    };

    const send = async (who: { target: string } | { accountId: string }, busyKey: string) => {
        setBusy(busyKey); setError(null);
        try {
            await share({ machineId, terminalId, title, who, role: 'viewer', expiresInDays: expiry });
            setTarget('');
        } catch (e) {
            setError(errorCopy(t, e));
        } finally {
            setBusy(null);
        }
    };

    const request = (who: { target: string } | { accountId: string }, name: string, busyKey: string) => {
        if (busy) return;
        if (role === 'operator') {
            if (!operatorAck) { setError(t('share.operator.acknowledge')); return; }
            setConfirmError(null);
            setPendingOperator({ kind: 'new', who, name });
            return;
        }
        void send(who, busyKey);
    };

    const confirmOperator = async () => {
        if (!pendingOperator || confirmBusy) return;
        setConfirmBusy(true); setConfirmError(null);
        try {
            if (pendingOperator.kind === 'new') {
                await share({ machineId, terminalId, title, who: pendingOperator.who, role: 'operator', expiresInDays: expiry, confirmOperator: true });
                setTarget(''); setOperatorAck(false);
            } else {
                await update(pendingOperator.grant, { role: 'operator', expiresInDays: expiry, confirmOperator: true });
            }
            setPendingOperator(null);
        } catch (e) {
            setConfirmError(errorCopy(t, e));
        } finally {
            setConfirmBusy(false);
        }
    };

    const onRole = async (grant: TerminalGrantView, next: TerminalShareRole) => {
        if (next === grant.role) return;
        if (next === 'operator') {
            setExpiry(defaultTerminalShareExpiry('operator'));
            setConfirmError(null);
            setPendingOperator({ kind: 'upgrade', grant });
            return;
        }
        try { await update(grant, { role: 'viewer' }); } catch (e) { setListError(errorCopy(t, e)); }
    };

    const onRevoke = async (grant: TerminalGrantView) => {
        setConfirmRevoke(null);
        try { await revoke(grant); } catch (e) { setListError(errorCopy(t, e)); }
    };

    const watchingIds = new Set(watchers.map((w) => w.grantId));

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
                <Dialog.Content className="vh-dialog so-dialog" aria-describedby={undefined}>
                    <div className="vh-dialog-head so-head">
                        <div>
                            <Dialog.Title className="vh-dialog-title so-title">{t('share.terminal.title')}</Dialog.Title>
                            <Dialog.Description className="so-description">{t('share.terminal.description')}</Dialog.Description>
                        </div>
                        <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                    </div>

                    <form className="shd-form" onSubmit={(e) => { e.preventDefault(); const v = target.trim(); if (v) request({ target: v }, v, 'form'); }}>
                        {pickable.length > 0 && (
                            <div className="shd-friends" role="group" aria-label={t('share.dialog.friendsLabel')}>
                                <span className="shd-friends-label">{t('share.dialog.friendsLabel')}</span>
                                <div className="shd-friends-row">
                                    {pickable.map((f) => {
                                        const name = getDisplayName(f);
                                        return (
                                            <button key={f.id} type="button" className="shd-friend" disabled={busy !== null} aria-busy={busy === f.id} title={t('share.dialog.friendHint', { name })} onClick={() => request({ accountId: f.id }, name, f.id)}>
                                                <span className="shd-grant-avatar" aria-hidden>{f.avatar?.url ? <img src={f.avatar.url} alt="" /> : initials(name)}</span>
                                                <span className="shd-friend-name">{name}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        <div className="shd-row">
                            <Input
                                label={t('share.dialog.targetLabel')}
                                placeholder={t('share.dialog.targetPlaceholder')}
                                value={target}
                                onChange={(e) => setTarget(e.target.value)}
                                autoFocus
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                inputMode="email"
                            />
                            {role === 'operator'
                                ? <Button type="submit" variant="danger" size="md" disabled={target.trim().length === 0 || !operatorAck}>{t('share.operator.grantButton')}</Button>
                                : <Button type="submit" variant="primary" size="md" loading={busy === 'form'} disabled={target.trim().length === 0}>{t('share.dialog.shareButton')}</Button>}
                        </div>
                        <div className="shd-role" role="group" aria-label={t('share.dialog.roleLabel')}>
                            <button type="button" className="shd-role-btn" aria-pressed={role === 'viewer'} onClick={() => pickRole('viewer')}>
                                <span className="shd-role-name">{t('share.roleViewer')}</span>
                                <span className="shd-role-hint">{t('share.terminal.roleViewerHint')}</span>
                            </button>
                            <button type="button" className="shd-role-btn shd-role-btn--operator" aria-pressed={role === 'operator'} onClick={() => pickRole('operator')}>
                                <span className="shd-role-name">{t('share.roleOperator')}</span>
                                <span className="shd-role-hint">{t('share.terminal.roleOperatorHint')}</span>
                            </button>
                        </div>
                        <div className="shd-link-row">
                            <span className="shd-inline-label" id={`tsd-exp-${terminalId}`}>{t('share.expiry.label')}</span>
                            <OperatorExpirySelect labelledBy={`tsd-exp-${terminalId}`} value={expiry} onChange={setExpiry} />
                        </div>
                        {role === 'viewer' && (
                            <p className="shd-note" role="note"><Info size={15} aria-hidden />{t('share.terminal.viewerNotice')}</p>
                        )}
                        {role === 'operator' && <>
                            <OperatorWarning compact />
                            <Checkbox className="shd-opack" checked={operatorAck} onCheckedChange={setOperatorAck}>{t('share.operator.acknowledge')}</Checkbox>
                        </>}
                        <p className="shd-note shd-note--quiet">{t('share.terminal.mirrorNotice')}</p>
                        {error && <p className="shd-error" role="alert">{error}</p>}
                    </form>

                    <div className="shd-list">
                        <p className="shd-list-title">{t('share.dialog.listTitle')}</p>
                        {listError && <p className="shd-error" role="alert">{listError}</p>}
                        {grants === undefined && !listError && <p className="shd-empty">{t('common.loading')}</p>}
                        {grants && grants.length === 0 && <p className="shd-empty">{t('share.dialog.empty')}</p>}
                        {grants?.map((grant) => confirmRevoke === grant.id ? (
                            <div key={grant.id} className="shd-grant shd-grant--confirm" role="group" aria-label={t('share.dialog.revoke')}>
                                <span className="shd-grant-text">
                                    <span className="shd-grant-name">{t('share.dialog.revokeConfirm', { name: grant.grantee.displayName })}</span>
                                </span>
                                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>{t('common.cancel')}</Button>
                                <Button type="button" variant="danger" size="sm" onClick={() => void onRevoke(grant)}>{t('share.dialog.revoke')}</Button>
                            </div>
                        ) : (
                            <div key={grant.id} className="shd-grant-wrap">
                                <div className="shd-grant">
                                    <span className="shd-grant-avatar" aria-hidden>{initials(grant.grantee.displayName)}</span>
                                    <span className="shd-grant-text">
                                        <span className="shd-grant-name">{grant.grantee.displayName}</span>
                                        <span className="shd-grant-sub">{[
                                            grant.grantee.username,
                                            grant.status === 'pending' ? t('share.dialog.statusPending') : null,
                                            watchingIds.has(grant.id) ? t('share.terminal.watchingNow') : null,
                                            remainingDaysLabel(t, grant.expiresAt),
                                        ].filter(Boolean).join(' · ')}</span>
                                    </span>
                                    <SelectMenu<TerminalShareRole>
                                        className="shd-grant-picker"
                                        value={grant.role}
                                        label={t('share.dialog.roleLabel')}
                                        align="end"
                                        options={[
                                            { value: 'viewer', label: t('share.roleViewer') },
                                            { value: 'operator', label: t('share.roleOperator') },
                                        ]}
                                        onChange={(next) => void onRole(grant, next)}
                                    />
                                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(grant.id)}>{t('share.dialog.revoke')}</Button>
                                </div>
                                <div className="shd-opevents-wrap">
                                    <button type="button" className="shd-opevents-toggle" aria-expanded={eventsOpen === grant.id} onClick={() => setEventsOpen(eventsOpen === grant.id ? null : grant.id)}>
                                        {eventsOpen === grant.id ? t('share.operator.eventsHide') : t('share.operator.eventsShow')}
                                    </button>
                                    {eventsOpen === grant.id && <TerminalShareEventsList grantId={grant.id} actorName={grant.grantee.displayName} />}
                                </div>
                            </div>
                        ))}
                    </div>
                    <OperatorConfirmDialog
                        open={pendingOperator !== null}
                        name={pendingOperator?.kind === 'upgrade' ? pendingOperator.grant.grantee.displayName : pendingOperator?.name ?? ''}
                        host={host}
                        expiry={expiry}
                        onExpiry={pendingOperator?.kind === 'upgrade' ? setExpiry : undefined}
                        needsAck={pendingOperator?.kind === 'upgrade'}
                        busy={confirmBusy}
                        error={confirmError}
                        onCancel={() => setPendingOperator(null)}
                        onConfirm={() => void confirmOperator()}
                        compactWarning
                    />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
