/**
 * B-701 「链接」 tab of the share dialog: create a read-only link (snapshot or
 * live, 1/7/30 days or never), copy it once, and manage existing links
 * (update snapshot, new link, revoke). The one-sentence pointer to People
 * sharing is the answer to "can they send?" — links never can (spec §1.3).
 */
import { useEffect, useState } from 'react';
import { Info, Link2 } from 'lucide-react';
import { useSessionShares } from '@/sync/sessionSharesStore';
import { SessionShareApiError, shareLinkUrl } from '@/sync/apiSessionShares';
import { SHARE_EXPIRY_CHOICES, type ShareExpiryDays, type ShareLinkScope, type ShareLinkView } from '@/sync/sessionShareTypes';
import { Button, CopyButton, toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { expiryLabel, formatShareTime, remainingDaysLabel } from './shareFormat';

type T = ReturnType<typeof useTranslation>['t'];

function linkErrorCopy(t: T, error: unknown): string {
    const code = error instanceof SessionShareApiError ? error.code : 'unknown';
    if (code === 'too_many_links') return t('share.link.errors.tooMany');
    if (code === 'http_404') return t('share.dialog.errors.serverTooOld');
    if (code === 'session_not_shareable') return t('share.dialog.errors.notShareable');
    if (code === 'session_key_unavailable') return t('share.dialog.errors.ownerKey');
    return t('share.link.errors.generic', { error: code });
}

export function ExpirySelect({ value, onChange, id }: { value: ShareExpiryDays; onChange: (v: ShareExpiryDays) => void; id?: string }) {
    const { t } = useTranslation();
    return (
        <select id={id} className="shd-grant-role shd-expiry" value={value === null ? 'never' : String(value)} aria-label={t('share.expiry.label')}
            onChange={(e) => onChange(e.target.value === 'never' ? null : Number(e.target.value) as ShareExpiryDays)}>
            {SHARE_EXPIRY_CHOICES.map((c) => <option key={String(c)} value={c === null ? 'never' : String(c)}>{expiryLabel(t, c)}</option>)}
        </select>
    );
}

function linkSub(t: T, link: ShareLinkView): string {
    const parts: string[] = [];
    parts.push(link.scope === 'live' ? t('share.link.live') : t('share.link.snapshotAt', { time: link.snapshotAt ? formatShareTime(link.snapshotAt) : '—' }));
    if (link.status === 'revoked') parts.push(t('share.link.statusRevoked'));
    else if (link.status === 'expired') parts.push(t('share.link.statusExpired'));
    else parts.push(link.expiresAt ? remainingDaysLabel(t, link.expiresAt) : t('share.expiry.never'));
    parts.push(t('share.link.opens', { count: link.accessCount }));
    if (link.lastAccessedAt) parts.push(t('share.link.lastOpened', { time: formatShareTime(link.lastAccessedAt) }));
    return parts.join(' · ');
}

export function ShareLinkPanel({ sessionId, open }: { sessionId: string; open: boolean }) {
    const { t } = useTranslation();
    const links = useSessionShares((s) => s.linksBySession[sessionId]);
    const refreshLinks = useSessionShares((s) => s.refreshLinks);
    const createLink = useSessionShares((s) => s.createLink);
    const updateLink = useSessionShares((s) => s.updateLink);
    const rotateLink = useSessionShares((s) => s.rotateLink);
    const revokeLink = useSessionShares((s) => s.revokeLink);
    const [scope, setScope] = useState<ShareLinkScope>('snapshot');
    const [expiry, setExpiry] = useState<ShareExpiryDays>(7);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fresh, setFresh] = useState<string | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null); setFresh(null); setConfirmRevoke(null);
        refreshLinks(sessionId).catch((e) => setError(linkErrorCopy(t, e)));
    }, [open, sessionId, refreshLinks, t]);

    const showFresh = async (created: { link: ShareLinkView; secret: string }) => {
        const url = shareLinkUrl(window.location.origin, created.link.id, created.secret);
        setFresh(url);
        try { await navigator.clipboard.writeText(url); toast.success(t('share.link.copied')); } catch { /* the field below stays visible for manual copy */ }
    };

    const run = async (work: () => Promise<void>) => {
        if (busy) return;
        setBusy(true); setError(null);
        try { await work(); } catch (e) { setError(linkErrorCopy(t, e)); } finally { setBusy(false); }
    };

    const visible = (links ?? []).filter((l) => l.status === 'active');

    return (
        <div className="shd-link">
            <p className="shd-note"><Info size={14} aria-hidden />{t('share.link.participateHint')}</p>
            <div className="shd-role" role="radiogroup" aria-label={t('share.link.scopeLabel')}>
                <button type="button" role="radio" className="shd-role-btn" aria-pressed={scope === 'snapshot'} aria-checked={scope === 'snapshot'} onClick={() => setScope('snapshot')}>
                    <span className="shd-role-name">{t('share.link.scopeSnapshot')}</span>
                    <span className="shd-role-hint">{t('share.link.scopeSnapshotHint')}</span>
                </button>
                <button type="button" role="radio" className="shd-role-btn" aria-pressed={scope === 'live'} aria-checked={scope === 'live'} onClick={() => setScope('live')}>
                    <span className="shd-role-name">{t('share.link.scopeLive')}</span>
                    <span className="shd-role-hint">{t('share.link.scopeLiveHint')}</span>
                </button>
            </div>
            <div className="shd-link-row">
                <label className="shd-inline-label" htmlFor={`shd-link-exp-${sessionId}`}>{t('share.expiry.label')}</label>
                <ExpirySelect id={`shd-link-exp-${sessionId}`} value={expiry} onChange={setExpiry} />
                <Button type="button" variant="primary" size="md" loading={busy} leftIcon={<Link2 size={15} />} onClick={() => void run(async () => showFresh(await createLink(sessionId, scope, expiry)))}>{t('share.link.create')}</Button>
            </div>
            <p className="shd-mask">{t('share.link.maskNotice')}</p>
            {fresh && (
                <div className="shd-fresh" role="status">
                    <span className="shd-fresh-hint">{t('share.link.created')}</span>
                    <div className="shd-fresh-row">
                        <input className="shd-fresh-url" readOnly value={fresh} aria-label={t('share.link.listTitle')} onFocus={(e) => e.currentTarget.select()} />
                        <CopyButton text={fresh} showLabel label={t('share.link.copy')} />
                    </div>
                </div>
            )}
            {error && <p className="shd-error" role="alert">{error}</p>}

            <div className="shd-list">
                <p className="shd-list-title">{t('share.link.listTitle')}</p>
                {links === undefined && !error && <p className="shd-empty">{t('common.loading')}</p>}
                {links && visible.length === 0 && <p className="shd-empty">{t('share.link.empty')}</p>}
                {visible.map((link) => confirmRevoke === link.id ? (
                    <div key={link.id} className="shd-grant shd-grant--confirm" role="group" aria-label={t('share.link.revoke')}>
                        <span className="shd-grant-text"><span className="shd-grant-name">{t('share.link.revokeConfirm')}</span></span>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>{t('common.cancel')}</Button>
                        <Button type="button" variant="danger" size="sm" onClick={() => { setConfirmRevoke(null); void run(() => revokeLink(sessionId, link.id)); }}>{t('share.link.revoke')}</Button>
                    </div>
                ) : (
                    <div key={link.id} className="shd-grant shd-link-item">
                        <span className="shd-grant-avatar" aria-hidden><Link2 size={14} /></span>
                        <span className="shd-grant-text">
                            <span className="shd-grant-name">…{link.id.slice(-6)}</span>
                            <span className="shd-grant-sub">{linkSub(t, link)}</span>
                        </span>
                        <span className="shd-link-actions">
                            {link.scope === 'snapshot' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => updateLink(sessionId, link.id, { snapshotToNow: true }))}>{t('share.link.updateToNow')}</Button>}
                            <Button type="button" variant="ghost" size="sm" disabled={busy} title={t('share.link.rotateHint')} onClick={() => void run(async () => showFresh(await rotateLink(sessionId, link.id)))}>{t('share.link.rotate')}</Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRevoke(link.id)}>{t('share.link.revoke')}</Button>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
