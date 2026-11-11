/**
 * ShareDialog (B-619) — the owner's one place to share a session: who
 * (email or username on this server), how much (viewer / driver), who has
 * it now, and the way back (re-role, revoke). The driver warning is part
 * of the form, not a tooltip: a driver can make the agent act on the
 * owner's machine under the owner's permission mode (spec security audit).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { DialogContent } from '@/ui/DialogContent';
import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSessionShares } from '@/sync/sessionSharesStore';
import { useAcceptedFriends, useSession } from '@/sync/storage';
import { getDisplayName } from '@/sync/friendTypes';
import { SessionShareApiError } from '@/sync/apiSessionShares';
import { tierOf, type SessionGrantView, type ShareExpiryDays, type ShareTier } from '@/sync/sessionShareTypes';
import { Button, Checkbox, Input } from '@/ui';
import { SelectMenu } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import { ExpirySelect, ShareLinkPanel } from './ShareLinkPanel';
import { remainingDaysLabel } from './shareFormat';
import { OPERATOR_DEFAULT_EXPIRY, OperatorConfirmDialog, OperatorEventsList, OperatorExpirySelect, OperatorWarning, operatorExpiryOf } from './OperatorGrant';
import './sessionOptionsDialog.css';
import './shared.css';

type T = ReturnType<typeof useTranslation>['t'];

export function shareErrorCopy(t: T, code: string): string {
    switch (code) {
        case 'target_not_found': return t('share.dialog.errors.targetNotFound');
        case 'already_shared': return t('share.dialog.errors.alreadyShared');
        case 'cannot_share_with_self': return t('share.dialog.errors.self');
        case 'session_not_shareable': return t('share.dialog.errors.notShareable');
        case 'session_key_unavailable': return t('share.dialog.errors.ownerKey');
        case 'grantee_key_unavailable': return t('share.dialog.errors.granteeKey');
        case 'too_many_grants': return t('share.dialog.errors.tooMany');
        // B-867: the server refuses an unconfirmed / never-expiring operator grant.
        case 'operator_requires_confirm':
        case 'operator_requires_driver':
        case 'operator_requires_expiry': return t('share.operator.expiryRequired');
        case 'http_404': return t('share.dialog.errors.serverTooOld');
        default: return t('share.dialog.errors.generic', { error: code });
    }
}

function initials(name: string): string {
    return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function ShareDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useTranslation();
    const grants = useSessionShares((s) => s.grantsBySession[sessionId]);
    const refreshGrants = useSessionShares((s) => s.refreshGrants);
    const share = useSessionShares((s) => s.share);
    const setRole = useSessionShares((s) => s.setRole);
    const setOperate = useSessionShares((s) => s.setOperate);
    const host = useSession(sessionId)?.metadata?.host ?? null;
    const revoke = useSessionShares((s) => s.revoke);
    const [target, setTarget] = useState('');
    // B-621: friends first — one tap, no typing. Already-granted people drop out of the row.
    const friends = useAcceptedFriends();
    const grantedIds = new Set((grants ?? []).map((g) => g.grantee.id));
    const pickable = friends.filter((f) => !grantedIds.has(f.id));
    const [picking, setPicking] = useState<string | null>(null);
    const [role, setRoleChoice] = useState<ShareTier>('viewer');
    // B-867 operator: finite expiry (default 1 day), an inline acknowledgement,
    // then a second confirmation modal before anything is sent.
    const [operatorExpiry, setOperatorExpiry] = useState(OPERATOR_DEFAULT_EXPIRY);
    const [operatorAck, setOperatorAck] = useState(false);
    const [pendingOperator, setPendingOperator] = useState<{ kind: 'new'; who: { target: string } | { accountId: string }; name: string } | { kind: 'upgrade'; grant: SessionGrantView } | null>(null);
    const [confirmError, setConfirmError] = useState<string | null>(null);
    const [confirmBusy, setConfirmBusy] = useState(false);
    const [eventsOpen, setEventsOpen] = useState<string | null>(null);
    // B-701: two tiers in one dialog; contact grants default to "never" (the B-619 behaviour).
    const [tab, setTab] = useState<'contacts' | 'link'>('contacts');
    const [expiry, setExpiry] = useState<ShareExpiryDays>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    // Inline two-step revoke: a global confirm modal would sit UNDER this Radix dialog.
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null); setListError(null); setConfirmRevoke(null); setPendingOperator(null); setOperatorAck(false);
        refreshGrants(sessionId).catch((e) => setListError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown')));
    }, [open, sessionId, refreshGrants, t]);

    const submit = async () => {
        const value = target.trim();
        if (!value || busy) return;
        if (role === 'operator') {
            if (!operatorAck) return;
            setConfirmError(null);
            setPendingOperator({ kind: 'new', who: { target: value }, name: value });
            return;
        }
        setBusy(true); setError(null);
        try {
            await share(sessionId, { target: value }, role, expiry);
            setTarget('');
        } catch (e) {
            setError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown'));
        } finally {
            setBusy(false);
        }
    };

    const shareWithFriend = async (accountId: string, name: string) => {
        if (busy || picking) return;
        if (role === 'operator') {
            if (!operatorAck) { setError(t('share.operator.acknowledge')); return; }
            setConfirmError(null);
            setPendingOperator({ kind: 'new', who: { accountId }, name });
            return;
        }
        setPicking(accountId); setError(null);
        try {
            await share(sessionId, { accountId }, role, expiry);
        } catch (e) {
            setError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown'));
        } finally {
            setPicking(null);
        }
    };

    const onRevoke = async (grant: SessionGrantView) => {
        setConfirmRevoke(null);
        try { await revoke(sessionId, grant.grantee.id); }
        catch (e) { setListError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown')); }
    };

    const onRole = async (grant: SessionGrantView, next: ShareTier) => {
        const current = tierOf(grant);
        if (next === current) return;
        if (next === 'operator') {
            setConfirmError(null);
            setOperatorExpiry(OPERATOR_DEFAULT_EXPIRY);
            setPendingOperator({ kind: 'upgrade', grant });
            return;
        }
        try {
            // Leaving operator for "Can send" only drops the tier; "View only" clears it server-side too.
            if (current === 'operator' && next === 'driver') await setOperate(sessionId, grant.grantee.id, false);
            else await setRole(sessionId, grant.grantee.id, next);
        }
        catch (e) { setListError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown')); }
    };

    const confirmOperator = async () => {
        if (!pendingOperator || confirmBusy) return;
        setConfirmBusy(true); setConfirmError(null);
        try {
            if (pendingOperator.kind === 'new') {
                await share(sessionId, pendingOperator.who, 'driver', operatorExpiry, { operate: true, confirmOperator: true });
                setTarget(''); setOperatorAck(false);
            } else {
                await setOperate(sessionId, pendingOperator.grant.grantee.id, true, operatorExpiry);
            }
            setPendingOperator(null);
        } catch (e) {
            setConfirmError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown'));
        } finally {
            setConfirmBusy(false);
        }
    };

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
                <DialogContent className="vh-dialog so-dialog" aria-describedby={undefined}>
                    <div className="vh-dialog-head so-head">
                        <div>
                            <Dialog.Title className="vh-dialog-title so-title">{t('share.dialog.title')}</Dialog.Title>
                            <Dialog.Description className="so-description">{t('share.dialog.description')}</Dialog.Description>
                        </div>
                        <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                    </div>

                    <div className="vh-segmented shd-tabs" role="tablist" aria-label={t('share.dialog.title')}>
                        <button type="button" role="tab" aria-selected={tab === 'contacts'} onClick={() => setTab('contacts')}>{t('share.tabs.contacts')}</button>
                        <button type="button" role="tab" aria-selected={tab === 'link'} onClick={() => setTab('link')}>{t('share.tabs.link')}</button>
                    </div>

                    {tab === 'link' ? <ShareLinkPanel sessionId={sessionId} open={open} /> : <>
                    <form className="shd-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                        {pickable.length > 0 && (
                            <div className="shd-friends" role="group" aria-label={t('share.dialog.friendsLabel')}>
                                <span className="shd-friends-label">{t('share.dialog.friendsLabel')}</span>
                                <div className="shd-friends-row">
                                    {pickable.map((f) => {
                                        const name = getDisplayName(f);
                                        return (
                                            <button key={f.id} type="button" className="shd-friend" disabled={busy || picking !== null} aria-busy={picking === f.id} title={t('share.dialog.friendHint', { name })} onClick={() => void shareWithFriend(f.id, name)}>
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
                                : <Button type="submit" variant="primary" size="md" loading={busy} disabled={target.trim().length === 0}>{t('share.dialog.shareButton')}</Button>}
                        </div>
                        <div className="shd-role" role="group" aria-label={t('share.dialog.roleLabel')}>
                            <button type="button" className="shd-role-btn" aria-pressed={role === 'viewer'} onClick={() => setRoleChoice('viewer')}>
                                <span className="shd-role-name">{t('share.roleViewer')}</span>
                                <span className="shd-role-hint">{t('share.dialog.roleViewerHint')}</span>
                            </button>
                            <button type="button" className="shd-role-btn" aria-pressed={role === 'driver'} onClick={() => setRoleChoice('driver')}>
                                <span className="shd-role-name">{t('share.roleDriver')}</span>
                                <span className="shd-role-hint">{t('share.dialog.roleDriverHint')}</span>
                            </button>
                            <button type="button" className="shd-role-btn shd-role-btn--operator" aria-pressed={role === 'operator'} onClick={() => { setRoleChoice('operator'); setOperatorAck(false); setOperatorExpiry(operatorExpiryOf(expiry)); }}>
                                <span className="shd-role-name">{t('share.roleOperator')}</span>
                                <span className="shd-role-hint">{t('share.operator.roleHint')}</span>
                            </button>
                        </div>
                        <div className="shd-link-row">
                            <span className="shd-inline-label" id={`shd-grant-exp-${sessionId}`}>{t('share.expiry.label')}</span>
                            {role === 'operator'
                                ? <OperatorExpirySelect labelledBy={`shd-grant-exp-${sessionId}`} value={operatorExpiry} onChange={setOperatorExpiry} />
                                : <ExpirySelect labelledBy={`shd-grant-exp-${sessionId}`} value={expiry} onChange={setExpiry} />}
                        </div>
                        {role === 'driver' && (
                            <p className="shd-warn"><ShieldAlert size={15} aria-hidden />{t('share.dialog.driverWarning')}</p>
                        )}
                        {role === 'operator' && <>
                            <OperatorWarning />
                            <Checkbox className="shd-opack" checked={operatorAck} onCheckedChange={setOperatorAck}>{t('share.operator.acknowledge')}</Checkbox>
                        </>}
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
                                <span className="shd-grant-avatar" aria-hidden>
                                    {grant.grantee.avatar?.url ? <img src={grant.grantee.avatar.url} alt="" /> : initials(grant.grantee.displayName)}
                                </span>
                                <span className="shd-grant-text">
                                    <span className="shd-grant-name">{grant.grantee.displayName}</span>
                                    <span className="shd-grant-sub">{[grant.grantee.email ?? grant.grantee.username, grant.status === 'pending' ? t('share.dialog.statusPending') : null, grant.expiresAt ? remainingDaysLabel(t, grant.expiresAt) : null].filter(Boolean).join(' · ')}</span>
                                </span>
                                <SelectMenu<ShareTier>
                                    className="shd-grant-picker"
                                    value={tierOf(grant)}
                                    label={t('share.dialog.roleLabel')}
                                    align="end"
                                    options={[
                                        { value: 'viewer', label: t('share.roleViewer') },
                                        { value: 'driver', label: t('share.roleDriver') },
                                        { value: 'operator', label: t('share.roleOperator') },
                                    ]}
                                    onChange={(next) => void onRole(grant, next)}
                                />
                                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(grant.id)}>{t('share.dialog.revoke')}</Button>
                            </div>
                            {tierOf(grant) === 'operator' && (
                                <div className="shd-opevents-wrap">
                                    <button type="button" className="shd-opevents-toggle" aria-expanded={eventsOpen === grant.id} onClick={() => setEventsOpen(eventsOpen === grant.id ? null : grant.id)}>
                                        {eventsOpen === grant.id ? t('share.operator.eventsHide') : t('share.operator.eventsShow')}
                                    </button>
                                    {eventsOpen === grant.id && <OperatorEventsList sessionId={sessionId} accountId={grant.grantee.id} actorName={grant.grantee.displayName} />}
                                </div>
                            )}
                            </div>
                        ))}
                    </div>
                    </>}
                    <OperatorConfirmDialog
                        open={pendingOperator !== null}
                        name={pendingOperator?.kind === 'upgrade' ? pendingOperator.grant.grantee.displayName : pendingOperator?.name ?? ''}
                        host={host}
                        expiry={operatorExpiry}
                        onExpiry={pendingOperator?.kind === 'upgrade' ? setOperatorExpiry : undefined}
                        needsAck={pendingOperator?.kind === 'upgrade'}
                        busy={confirmBusy}
                        error={confirmError}
                        onCancel={() => setPendingOperator(null)}
                        onConfirm={() => void confirmOperator()}
                    />
                </DialogContent>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
