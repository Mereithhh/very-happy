/**
 * ProjectShareDialog (B-878 PR-B) — the owner shares a whole project with one
 * person: view only or can send. Access is derived from current membership,
 * so sessions added later are included and sessions moved out stop being
 * visible. Terminals in the project are always view only; "can operate" is
 * never offered here (only per session or terminal).
 *
 * B-899: each person's "Terminal access…" lists my terminals in this project;
 * picking one opens that terminal's own share dialog with this person and
 * "can operate" filled in — the per-terminal grant, its confirmation and
 * expiry are unchanged (no project-wide operate).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Info, ShieldAlert, SquareTerminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAcceptedFriends } from '@/sync/storage';
import { getDisplayName } from '@/sync/friendTypes';
import { SessionShareApiError } from '@/sync/apiSessionShares';
import { useProjectShares } from '@/sync/projectSharesStore';
import type { ProjectGrantView, ProjectShareExpiry, ProjectShareRole } from '@/sync/projectShareTypes';
import { Button, Input } from '@/ui';
import { SelectMenu } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import { shareErrorCopy } from '@/screens/session/ShareDialog';
import { ExpirySelect } from '@/screens/session/ShareLinkPanel';
import { remainingDaysLabel } from '@/screens/session/shareFormat';
import { TerminalShareDialog } from '@/screens/terminal/TerminalShareDialog';
import { useTerminalSessions } from '@/sync/terminalSessions';
import type { TerminalSession } from '@/sync/terminalPushOps';
import '@/screens/session/sessionOptionsDialog.css';
import '@/screens/session/shared.css';
import '@/screens/terminal/terminalShare.css';

function initials(name: string): string {
    return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function ProjectShareDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useTranslation();
    const grants = useProjectShares((s) => s.grantsByProject[projectId]);
    const refreshGrants = useProjectShares((s) => s.refreshGrants);
    const share = useProjectShares((s) => s.share);
    const update = useProjectShares((s) => s.update);
    const revoke = useProjectShares((s) => s.revoke);
    const friends = useAcceptedFriends();
    const grantedIds = new Set((grants ?? []).map((g) => g.grantee.id));
    const pickable = friends.filter((f) => !grantedIds.has(f.id));
    const [target, setTarget] = useState('');
    const [role, setRole] = useState<ProjectShareRole>('viewer');
    const [expiry, setExpiry] = useState<ProjectShareExpiry>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
    const [termsFor, setTermsFor] = useState<string | null>(null);
    const [operate, setOperate] = useState<{ term: TerminalSession; accountId: string; name: string } | null>(null);
    const allTerminals = useTerminalSessions((s) => s.terminals);
    const projectTerminals = allTerminals.filter((tm) => tm.projectId === projectId);
    const copy = (e: unknown) => {
        const code = e instanceof SessionShareApiError ? e.code : 'unknown';
        return code === 'http_404' ? t('share.project.serverTooOld') : shareErrorCopy(t, code);
    };

    useEffect(() => {
        if (!open) return;
        setError(null); setListError(null); setConfirmRevoke(null); setTermsFor(null);
        refreshGrants(projectId).catch((e) => setListError(copy(e)));
    }, [open, projectId, refreshGrants]);

    const send = async (who: { target: string } | { accountId: string }, key: string) => {
        if (busy) return;
        setBusy(key); setError(null);
        try { await share(projectId, who, role, expiry); setTarget(''); }
        catch (e) { setError(copy(e)); }
        finally { setBusy(null); }
    };
    const onRole = async (grant: ProjectGrantView, next: ProjectShareRole) => {
        if (next === grant.role) return;
        try { await update(grant, { role: next }); } catch (e) { setListError(copy(e)); }
    };
    const onRevoke = async (grant: ProjectGrantView) => {
        setConfirmRevoke(null);
        try { await revoke(grant); } catch (e) { setListError(copy(e)); }
    };

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
                <Dialog.Content className="vh-dialog so-dialog" aria-describedby={undefined}>
                    <div className="vh-dialog-head so-head">
                        <div>
                            <Dialog.Title className="vh-dialog-title so-title">{t('share.project.title')}</Dialog.Title>
                            <Dialog.Description className="so-description">{t('share.project.description')}</Dialog.Description>
                        </div>
                        <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                    </div>
                    <form className="shd-form" onSubmit={(e) => { e.preventDefault(); const v = target.trim(); if (v) void send({ target: v }, 'form'); }}>
                        {pickable.length > 0 && (
                            <div className="shd-friends" role="group" aria-label={t('share.dialog.friendsLabel')}>
                                <span className="shd-friends-label">{t('share.dialog.friendsLabel')}</span>
                                <div className="shd-friends-row">
                                    {pickable.map((f) => {
                                        const name = getDisplayName(f);
                                        return (
                                            <button key={f.id} type="button" className="shd-friend" disabled={busy !== null} aria-busy={busy === f.id} title={t('share.dialog.friendHint', { name })} onClick={() => void send({ accountId: f.id }, f.id)}>
                                                <span className="shd-grant-avatar" aria-hidden>{f.avatar?.url ? <img src={f.avatar.url} alt="" /> : initials(name)}</span>
                                                <span className="shd-friend-name">{name}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        <div className="shd-row">
                            <Input label={t('share.dialog.targetLabel')} placeholder={t('share.dialog.targetPlaceholder')} value={target} onChange={(e) => setTarget(e.target.value)} autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="email" />
                            <Button type="submit" variant="primary" size="md" loading={busy === 'form'} disabled={target.trim().length === 0}>{t('share.dialog.shareButton')}</Button>
                        </div>
                        <div className="shd-role" role="group" aria-label={t('share.dialog.roleLabel')}>
                            <button type="button" className="shd-role-btn" aria-pressed={role === 'viewer'} onClick={() => setRole('viewer')}>
                                <span className="shd-role-name">{t('share.roleViewer')}</span>
                                <span className="shd-role-hint">{t('share.project.roleViewerHint')}</span>
                            </button>
                            <button type="button" className="shd-role-btn" aria-pressed={role === 'driver'} onClick={() => setRole('driver')}>
                                <span className="shd-role-name">{t('share.roleDriver')}</span>
                                <span className="shd-role-hint">{t('share.project.roleDriverHint')}</span>
                            </button>
                        </div>
                        <div className="shd-link-row">
                            <span className="shd-inline-label" id={`psd-exp-${projectId}`}>{t('share.expiry.label')}</span>
                            <ExpirySelect labelledBy={`psd-exp-${projectId}`} value={expiry} onChange={setExpiry} />
                        </div>
                        {role === 'driver' && <p className="shd-warn"><ShieldAlert size={15} aria-hidden />{t('share.project.driverWarning')}</p>}
                        <p className="shd-note shd-note--quiet"><Info size={14} aria-hidden />{t('share.project.noOperate')}</p>
                        {error && <p className="shd-error" role="alert">{error}</p>}
                    </form>
                    <div className="shd-list">
                        <p className="shd-list-title">{t('share.dialog.listTitle')}</p>
                        {listError && <p className="shd-error" role="alert">{listError}</p>}
                        {grants === undefined && !listError && <p className="shd-empty">{t('common.loading')}</p>}
                        {grants && grants.length === 0 && <p className="shd-empty">{t('share.dialog.empty')}</p>}
                        {grants?.map((grant) => confirmRevoke === grant.id ? (
                            <div key={grant.id} className="shd-grant shd-grant--confirm" role="group" aria-label={t('share.dialog.revoke')}>
                                <span className="shd-grant-text"><span className="shd-grant-name">{t('share.dialog.revokeConfirm', { name: grant.grantee.displayName })}</span></span>
                                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>{t('common.cancel')}</Button>
                                <Button type="button" variant="danger" size="sm" onClick={() => void onRevoke(grant)}>{t('share.dialog.revoke')}</Button>
                            </div>
                        ) : (
                            <div key={grant.id} className="shd-grant-wrap">
                            <div className="shd-grant">
                                <span className="shd-grant-avatar" aria-hidden>{initials(grant.grantee.displayName)}</span>
                                <span className="shd-grant-text">
                                    <span className="shd-grant-name">{grant.grantee.displayName}</span>
                                    <span className="shd-grant-sub">{[grant.grantee.username, grant.status === 'pending' ? t('share.dialog.statusPending') : null, grant.expiresAt ? remainingDaysLabel(t, grant.expiresAt) : null].filter(Boolean).join(' · ')}</span>
                                </span>
                                <SelectMenu<ProjectShareRole>
                                    className="shd-grant-picker"
                                    value={grant.role}
                                    label={t('share.dialog.roleLabel')}
                                    align="end"
                                    options={[{ value: 'viewer', label: t('share.roleViewer') }, { value: 'driver', label: t('share.roleDriver') }]}
                                    onChange={(next) => void onRole(grant, next)}
                                />
                                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(grant.id)}>{t('share.dialog.revoke')}</Button>
                            </div>
                            <div className="shd-opevents-wrap">
                                <button type="button" className="shd-opevents-toggle" aria-expanded={termsFor === grant.id} onClick={() => setTermsFor(termsFor === grant.id ? null : grant.id)}>{t('share.project.operateTerminals')}</button>
                                {termsFor === grant.id && (
                                    <div className="shd-grant-terms" role="group" aria-label={t('share.project.operateTerminalsTitle', { name: grant.grantee.displayName })}>
                                        <p className="shd-grant-terms-hint">{projectTerminals.length === 0 ? t('share.project.noOwnTerminals') : t('share.project.operateTerminalsHint')}</p>
                                        {projectTerminals.map((tm) => (
                                            <button key={`${tm.machineId}:${tm.id}`} type="button" className="shd-grant-term" onClick={() => setOperate({ term: tm, accountId: grant.grantee.id, name: grant.grantee.displayName })}>
                                                <SquareTerminal size={14} aria-hidden /><span>{tm.title}</span><span className="shd-grant-terms-hint">{tm.machineName}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            </div>
                        ))}
                    </div>
                    {operate && (
                        <TerminalShareDialog
                            key={`${operate.term.machineId}:${operate.term.id}:${operate.accountId}`}
                            machineId={operate.term.machineId}
                            terminalId={operate.term.id}
                            title={operate.term.title}
                            host={operate.term.machineName || null}
                            prefill={{ accountId: operate.accountId, name: operate.name }}
                            open
                            onOpenChange={(next) => { if (!next) setOperate(null); }}
                        />
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
