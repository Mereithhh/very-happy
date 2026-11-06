/**
 * SharedProjectScreen (B-878 PR-B) — a project someone shared with me, at
 * `/shared/project/:grantId`. Same structure as my own project page, read
 * only: no composer, no settings, no new session / terminal. Sessions open
 * the normal shared-session page (view only or can send, per the share);
 * terminals open the view-only shared terminal page — or, when the owner
 * also shared that terminal with me directly, that grant's page (B-899:
 * effective = max(direct, project)). The list follows the
 * project's current membership (server-derived), re-read on every
 * `project-share-changed`.
 */
import { FolderKanban, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BackButton } from '@/app/BackButton';
import { Button } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { useSession } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { SessionShareApiError } from '@/sync/apiSessionShares';
import { getSharedProject } from '@/sync/apiProjectShares';
import { onProjectShareChanged, useIncomingProjectShares, useProjectShares } from '@/sync/projectSharesStore';
import { projectTerminalLink, type SharedProjectPage } from '@/sync/projectShareTypes';
import { useIncomingTerminalShares } from '@/sync/terminalSharesStore';
import { Markdown } from '@/screens/session/Markdown';
import './projects.css';

export function sharedProjectPath(grantId: string): string {
    return `/shared/project/${encodeURIComponent(grantId)}`;
}

export function SharedProjectScreen() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { grantId = '' } = useParams<{ grantId: string }>();
    const incoming = useIncomingProjectShares();
    const share = incoming.find((g) => g.id === grantId) ?? null;
    const ended = useProjectShares((s) => s.ended[grantId]);
    const respond = useProjectShares((s) => s.respond);
    const [page, setPage] = useState<SharedProjectPage | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'old'>('loading');
    const [tab, setTab] = useState<'overview' | 'context'>('overview');

    const load = useCallback(async () => {
        try { setPage(await getSharedProject(grantId)); setState('ready'); }
        catch (e) {
            const code = e instanceof SessionShareApiError ? e.code : '';
            setState(code === 'http_404' ? 'old' : 'missing');
        }
    }, [grantId]);
    useEffect(() => { void load(); }, [load, share?.status]);
    useEffect(() => onProjectShareChanged((id) => { if (id === grantId) void load(); }), [grantId, load]);
    // B-899: a direct terminal grant shared / accepted / re-roled / revoked changes where a terminal row leads.
    const directKey = useIncomingTerminalShares().map((g) => `${g.id}:${g.status}:${g.role}:${g.expiresAt}`).sort().join('|');
    useEffect(() => { if (directKey) void load(); }, [directKey]); // eslint-disable-line react-hooks/exhaustive-deps

    if (ended) return <Empty text={t('share.project.ended')} onHome={() => navigate('/')} />;
    if (share?.status === 'pending') {
        return (
            <Empty text={t('share.project.invite', { owner: share.owner.displayName, name: share.name })}>
                <Button type="button" variant="primary" size="md" onClick={() => void respond(share.id, true)}>{t('share.invites.accept')}</Button>
            </Empty>
        );
    }
    if (state === 'old') return <Empty text={t('share.project.serverTooOld')} onHome={() => navigate('/')} />;
    if (state === 'missing') return <Empty text={t('share.project.notFound')} onHome={() => navigate('/')} />;
    if (!page) return <Empty text={t('common.loading')} />;

    const owner = share?.owner.displayName ?? '';
    const leave = async () => {
        const ok = await Modal.confirm(t('share.project.leaveConfirm', { owner }), undefined, { confirmText: t('share.project.leave'), destructive: true });
        if (!ok) return;
        await respond(grantId, false);
        navigate('/');
    };
    return (
        <main className="pj-screen" data-testid="shared-project">
            <header className="pj-head">
                <div className="pj-head-text">
                    <div className="vh-back-row"><BackButton narrow /></div>
                    <h1><FolderKanban size={22} aria-hidden />{page.project.name}</h1>
                    <p className="pj-goal">{share?.role === 'driver' ? t('share.project.readOnlyDriver', { owner }) : t('share.project.readOnly', { owner })}</p>
                    {page.project.goal && <p className="pj-goal">{page.project.goal}</p>}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => void leave()}>{t('share.project.leave')}</Button>
            </header>
            <div className="vh-segmented pj-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>{t('share.project.sessions')}</button>
                <button type="button" role="tab" aria-selected={tab === 'context'} onClick={() => setTab('context')}>{t('share.project.instructions')}</button>
            </div>
            {tab === 'overview' ? (
                <div className="pj-overview">
                    <section className="pj-section">
                        <h2>{t('share.project.sessions')} <span className="pj-count">{page.sessionIds.length}</span></h2>
                        {page.sessionIds.length === 0 ? <p className="pj-muted pj-empty">{t('share.project.noSessions')}</p>
                            : page.sessionIds.map((id) => <SharedSessionLink key={id} sessionId={id} />)}
                    </section>
                    <section className="pj-section">
                        <h2>{t('share.project.terminals')} <span className="pj-count">{page.terminals.length}</span></h2>
                        {page.terminals.length === 0 ? <p className="pj-muted pj-empty">{t('share.project.noTerminals')}</p>
                            : page.terminals.map((term) => {
                                const link = projectTerminalLink(term, Date.now());
                                return (
                                    <Link key={term.shareId} className="pj-row" data-terminal-via={link.via} to={`/shared/terminal/${encodeURIComponent(link.shareId)}?title=${encodeURIComponent(term.title ?? '')}`}>
                                        <SquareTerminal size={14} aria-hidden />{term.title || t('share.terminal.untitled')}
                                        {term.cwd && <span className="pj-muted">· {term.cwd}</span>}
                                        <span className="pj-muted pj-row-role">{link.pending ? t('share.dialog.statusPending') : link.role === 'operator' ? t('share.roleOperator') : t('share.roleViewer')}</span>
                                    </Link>
                                );
                            })}
                    </section>
                </div>
            ) : (
                <div className="pj-overview">
                    <section className="pj-section">
                        <h2>{t('share.project.instructions')}</h2>
                        {page.project.instructions?.trim() ? <div className="pj-instr-preview"><Markdown text={page.project.instructions} /></div> : <p className="pj-muted pj-empty">{t('share.project.noInstructions')}</p>}
                    </section>
                    <section className="pj-section">
                        <h2>{t('share.project.log')} <span className="pj-count">{page.log.length}</span></h2>
                        {page.log.length === 0 ? <p className="pj-muted pj-empty">{t('share.project.noLog')}</p>
                            : page.log.filter((e) => !e.supersededBy).map((e) => (
                                <div key={e.id} className="pj-log-entry">
                                    <strong>{e.title}</strong> <span className="pj-muted">· {e.kind}</span>
                                    {e.body && <p className="pj-hint">{e.body}</p>}
                                </div>
                            ))}
                    </section>
                </div>
            )}
        </main>
    );
}

function SharedSessionLink({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    return (
        <Link className="pj-row" to={`/session/${encodeURIComponent(sessionId)}`}>
            {session ? getSessionName(session) : t('common.loading')}
        </Link>
    );
}

function Empty({ text, onHome, children }: { text: string; onHome?: () => void; children?: React.ReactNode }) {
    const { t } = useTranslation();
    return (
        <main className="pj-screen">
            <BackButton />
            <p className="pj-muted" role="status">{text}</p>
            {children}
            {onHome && <Button type="button" variant="secondary" size="md" onClick={onHome}>{t('share.terminal.backHome')}</Button>}
        </main>
    );
}
