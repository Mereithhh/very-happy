/**
 * Settings → Shared (B-701, spec specs/2026-10-session-sharing-tiers.md §4.2):
 * every contact grant and read-only link I have handed out, grouped by
 * session, each revocable in place; a link row expands to who opened it.
 *
 * Separate file on purpose: SettingsRoutes.tsx is a declared conflict
 * hot-zone — it only gains an import, one <Route> line and one overview <Item>.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, SquareTerminal, Users } from 'lucide-react';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { ItemList, ItemGroup, Item, Button } from '@/ui';
import { listOutgoingShares, listShareLinkAccesses, revokeSessionGrant, revokeShareLink } from '@/sync/apiSessionShares';
import type { OutgoingShares, ShareLinkAccess, ShareLinkView } from '@/sync/sessionShareTypes';
import { listOutgoingTerminalGrants, revokeTerminalGrant } from '@/sync/apiTerminalShares';
import type { TerminalGrantView } from '@/sync/terminalShareTypes';
import { useTranslation } from '@/i18n/useTranslation';
import { formatShareTime, remainingDaysLabel } from '@/screens/session/shareFormat';

type T = ReturnType<typeof useTranslation>['t'];

function linkSubtitle(t: T, link: ShareLinkView): string {
    return [
        link.scope === 'live' ? t('share.link.live') : t('share.link.snapshotAt', { time: link.snapshotAt ? formatShareTime(link.snapshotAt) : '—' }),
        link.status === 'expired' ? t('share.link.statusExpired') : link.expiresAt ? remainingDaysLabel(t, link.expiresAt) : t('share.expiry.never'),
        t('share.link.opens', { count: link.accessCount }),
        link.lastAccessedAt ? t('share.link.lastOpened', { time: formatShareTime(link.lastAccessedAt) }) : null,
    ].filter(Boolean).join(' · ');
}

function Accesses({ linkId }: { linkId: string }) {
    const { t } = useTranslation();
    const [rows, setRows] = useState<ShareLinkAccess[] | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => { listShareLinkAccesses(linkId).then(setRows, () => setFailed(true)); }, [linkId]);
    if (failed) return <Item title={t('share.settings.loadFailed')} />;
    if (!rows) return <Item title={t('common.loading')} />;
    if (rows.length === 0) return <Item title={t('share.settings.accessesEmpty')} />;
    return <>{rows.map((row, i) => (
        <Item key={i}
            title={row.bot ? t('share.settings.bot') : t('share.settings.anonymous')}
            subtitle={formatShareTime(row.at)} />
    ))}</>;
}

export function SharedSettings() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [data, setData] = useState<OutgoingShares | null>(null);
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);

    // B-878: terminal grants. An older server 404s here: the section just stays hidden.
    const [terminals, setTerminals] = useState<TerminalGrantView[] | null>(null);

    const load = useCallback(() => {
        listOutgoingShares().then((d) => { setData(d); setError(false); }, () => setError(true));
        listOutgoingTerminalGrants().then(setTerminals, () => setTerminals(null));
    }, []);
    useEffect(load, [load]);

    const revoke = async (key: string, work: () => Promise<void>) => {
        setBusy(key);
        try { await work(); load(); } catch { setError(true); } finally { setBusy(null); }
    };

    const sessions = data?.sessions.filter((s) => s.grants.length > 0 || s.links.some((l) => l.status !== 'revoked')) ?? [];

    return (
        <Page>
            <Header title={t('share.settings.title')} />
            <ItemList>
                <ItemGroup settingId="shared.list" title={t('share.settings.title')} footer={t('share.settings.subtitle')}>
                    {error ? <Item title={t('share.settings.loadFailed')} />
                        : !data ? <Item title={t('common.loading')} />
                        : <Item title={sessions.length === 0 ? t('share.settings.empty') : `${t('share.settings.people')} ${sessions.reduce((n, s) => n + s.grants.length, 0)} · ${t('share.settings.links')} ${sessions.reduce((n, s) => n + s.links.filter((l) => l.status !== 'revoked').length, 0)}`} />}
                </ItemGroup>
                {sessions.map((s) => (
                    <ItemGroup key={s.sessionId} title={s.title ?? t('share.page.untitled')}>
                        <Item title={t('share.settings.openSession')} onClick={() => navigate(`/session/${encodeURIComponent(s.sessionId)}`)} />
                        {s.grants.map((g) => (
                            <Item key={g.id}
                                left={<Users size={16} />}
                                title={g.grantee.displayName}
                                subtitle={[
                                    g.role === 'driver' ? (g.operate === true ? t('share.roleOperator') : t('share.roleDriver')) : t('share.roleViewer'),
                                    g.status === 'pending' ? t('share.dialog.statusPending') : null,
                                    g.status === 'expired' ? t('share.expiry.expired') : g.expiresAt ? remainingDaysLabel(t, g.expiresAt) : t('share.expiry.never'),
                                ].filter(Boolean).join(' · ')}
                                right={<Button type="button" variant="ghost" size="sm" loading={busy === g.id} onClick={() => void revoke(g.id, () => revokeSessionGrant(s.sessionId, g.grantee.id))}>{t('share.dialog.revoke')}</Button>} />
                        ))}
                        {s.links.filter((l) => l.status !== 'revoked').map((l) => (
                            <div key={l.id}>
                                <Item
                                    left={<Link2 size={16} />}
                                    title={`${t('share.tabs.link')} …${l.id.slice(-6)}`}
                                    subtitle={linkSubtitle(t, l)}
                                    right={<span className="shd-link-actions">
                                        <Button type="button" variant="ghost" size="sm" aria-expanded={expanded === l.id} onClick={() => setExpanded(expanded === l.id ? null : l.id)}>{t('share.settings.showAccesses')}</Button>
                                        <Button type="button" variant="ghost" size="sm" loading={busy === l.id} onClick={() => void revoke(l.id, () => revokeShareLink(s.sessionId, l.id))}>{t('share.link.revoke')}</Button>
                                    </span>} />
                                {expanded === l.id && <Accesses linkId={l.id} />}
                            </div>
                        ))}
                    </ItemGroup>
                ))}
                {terminals && terminals.length > 0 && (
                    <ItemGroup title={t('share.terminal.settingsTitle')}>
                        {terminals.map((g) => (
                            <Item key={g.id}
                                left={<SquareTerminal size={16} />}
                                title={`${g.title ?? t('share.terminal.untitled')} · ${g.grantee.displayName}`}
                                subtitle={[
                                    g.role === 'operator' ? t('share.roleOperator') : t('share.roleViewer'),
                                    g.status === 'pending' ? t('share.dialog.statusPending') : null,
                                    remainingDaysLabel(t, g.expiresAt),
                                ].filter(Boolean).join(' · ')}
                                onClick={() => navigate(`/terminal/${encodeURIComponent(g.machineId)}?tid=${encodeURIComponent(g.terminalId)}`)}
                                right={<Button type="button" variant="ghost" size="sm" loading={busy === g.id} onClick={(e) => { e.stopPropagation(); void revoke(g.id, () => revokeTerminalGrant(g.id)); }}>{t('share.dialog.revoke')}</Button>} />
                        ))}
                    </ItemGroup>
                )}
            </ItemList>
        </Page>
    );
}
