/**
 * ShareDialog (B-619) — the owner's one place to share a session: who
 * (email or username on this server), how much (viewer / driver), who has
 * it now, and the way back (re-role, revoke). The driver warning is part
 * of the form, not a tooltip: a driver can make the agent act on the
 * owner's machine under the owner's permission mode (spec security audit).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSessionShares } from '@/sync/sessionSharesStore';
import { useAcceptedFriends } from '@/sync/storage';
import { getDisplayName } from '@/sync/friendTypes';
import { SessionShareApiError } from '@/sync/apiSessionShares';
import type { SessionGrantView, SessionShareRole, ShareExpiryDays } from '@/sync/sessionShareTypes';
import { Button, Input } from '@/ui';
import { SelectMenu } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import { ExpirySelect, ShareLinkPanel } from './ShareLinkPanel';
import { remainingDaysLabel } from './shareFormat';
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
    const revoke = useSessionShares((s) => s.revoke);
    const [target, setTarget] = useState('');
    // B-621: friends first — one tap, no typing. Already-granted people drop out of the row.
    const friends = useAcceptedFriends();
    const grantedIds = new Set((grants ?? []).map((g) => g.grantee.id));
    const pickable = friends.filter((f) => !grantedIds.has(f.id));
    const [picking, setPicking] = useState<string | null>(null);
    const [role, setRoleChoice] = useState<SessionShareRole>('viewer');
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
        setError(null); setListError(null); setConfirmRevoke(null);
        refreshGrants(sessionId).catch((e) => setListError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown')));
    }, [open, sessionId, refreshGrants, t]);

    const submit = async () => {
        const value = target.trim();
        if (!value || busy) return;
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

    const shareWithFriend = async (accountId: string) => {
        if (busy || picking) return;
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

    const onRole = async (grant: SessionGrantView, next: SessionShareRole) => {
        if (next === grant.role) return;
        try { await setRole(sessionId, grant.grantee.id, next); }
        catch (e) { setListError(shareErrorCopy(t, e instanceof SessionShareApiError ? e.code : 'unknown')); }
    };

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="so-overlay" />
                <Dialog.Content className="so-dialog" aria-describedby={undefined}>
                    <div className="so-head">
                        <div>
                            <Dialog.Title className="so-title">{t('share.dialog.title')}</Dialog.Title>
                            <Dialog.Description className="so-description">{t('share.dialog.description')}</Dialog.Description>
                        </div>
                        <Dialog.Close className="so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
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
                                            <button key={f.id} type="button" className="shd-friend" disabled={busy || picking !== null} aria-busy={picking === f.id} title={t('share.dialog.friendHint', { name })} onClick={() => void shareWithFriend(f.id)}>
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
                            <Button type="submit" variant="primary" size="md" loading={busy} disabled={target.trim().length === 0}>{t('share.dialog.shareButton')}</Button>
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
                        </div>
                        <div className="shd-link-row">
                            <span className="shd-inline-label" id={`shd-grant-exp-${sessionId}`}>{t('share.expiry.label')}</span>
                            <ExpirySelect labelledBy={`shd-grant-exp-${sessionId}`} value={expiry} onChange={setExpiry} />
                        </div>
                        {role === 'driver' && (
                            <p className="shd-warn"><ShieldAlert size={15} aria-hidden />{t('share.dialog.driverWarning')}</p>
                        )}
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
                            <div key={grant.id} className="shd-grant">
                                <span className="shd-grant-avatar" aria-hidden>
                                    {grant.grantee.avatar?.url ? <img src={grant.grantee.avatar.url} alt="" /> : initials(grant.grantee.displayName)}
                                </span>
                                <span className="shd-grant-text">
                                    <span className="shd-grant-name">{grant.grantee.displayName}</span>
                                    <span className="shd-grant-sub">{[grant.grantee.email ?? grant.grantee.username, grant.status === 'pending' ? t('share.dialog.statusPending') : null, grant.expiresAt ? remainingDaysLabel(t, grant.expiresAt) : null].filter(Boolean).join(' · ')}</span>
                                </span>
                                <SelectMenu<SessionShareRole>
                                    className="shd-grant-picker"
                                    value={grant.role}
                                    label={t('share.dialog.roleLabel')}
                                    align="end"
                                    options={[
                                        { value: 'viewer', label: t('share.roleViewer') },
                                        { value: 'driver', label: t('share.roleDriver') },
                                    ]}
                                    onChange={(next) => void onRole(grant, next)}
                                />
                                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(grant.id)}>{t('share.dialog.revoke')}</Button>
                            </div>
                        ))}
                    </div>
                    </>}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
