/**
 * B-915 「交接给…」: pick the session that takes over, add an optional note,
 * choose whether to archive this one once the handoff is delivered. The
 * agent of THIS session writes the summary and delivers it (new CLI:
 * `handoff_send`; old CLI: `session_message`), so confirming only sends this
 * session one turn (`startHandoff`). One host is mounted in AppLayout; the
 * session header ⋯, the sidebar row ⋯ and `/handoff` open it by session id.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox } from '@/ui';
import { DialogHead } from '@/ui/DialogHead';
import { useTranslation } from '@/i18n/useTranslation';
import { storage, useAllSessions, useSession } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { registerHandoffOpener, startHandoff, supportsWrapupCard } from '@/app/sessionWrapup';
import { handoffCandidates } from './handoffTargets';
import '@/screens/sessions/newsession.css';
import './handoff.css';

export function HandoffDialogHost() {
    const [sessionId, setSessionId] = useState<string | null>(null);
    useEffect(() => {
        registerHandoffOpener(setSessionId);
        return () => registerHandoffOpener(null);
    }, []);
    if (!sessionId) return null;
    return <HandoffDialog key={sessionId} sessionId={sessionId} onClose={() => setSessionId(null)} />;
}

export function HandoffDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { t } = useTranslation();
    const source = useSession(sessionId);
    const sessions = useAllSessions();
    const machines = storage((s) => s.machines);
    const [query, setQuery] = useState('');
    const [target, setTarget] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const [archiveAfter, setArchiveAfter] = useState(false);
    const [busy, setBusy] = useState(false);
    const candidates = useMemo(() => handoffCandidates(sessions, machines, sessionId, query), [sessions, machines, sessionId, query]);
    const picked = target ? candidates.find((c) => c.id === target) ?? null : null;
    // A wrapper without `wrapup-v1` falls back to session_message: it cannot confirm delivery, so it never archives itself.
    const canArchive = supportsWrapupCard(source);
    useEffect(() => { document.getElementById('handoff-search')?.focus(); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const confirm = async () => {
        if (!picked || busy) return;
        setBusy(true);
        const outcome = await startHandoff(sessionId, {
            to: { id: picked.id, title: picked.title, machineId: picked.machineId },
            note,
            archiveAfter: canArchive && archiveAfter,
        });
        setBusy(false);
        if (outcome === 'sent' || outcome === 'already') onClose();
    };

    return (
        <div className="ns-backdrop vh-dialog-overlay" onClick={onClose}>
            <div className="ns-card vh-dialog hof-card" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title" onClick={(e) => e.stopPropagation()}>
                <DialogHead title={t('wrapup.dialogTitle')} titleId="handoff-dialog-title" description={source ? getSessionName(source) : undefined} onClose={onClose} />
                <p className="hof-desc">{t('wrapup.dialogDescription')}</p>
                <label className="ns-label" htmlFor="handoff-search">{t('wrapup.targetLabel')}</label>
                <input
                    id="handoff-search"
                    className="ns-input hof-search"
                    type="search"
                    value={query}
                    placeholder={t('wrapup.searchPlaceholder')}
                    autoComplete="off"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !target && candidates.length > 0) setTarget(candidates[0].id); }}
                />
                <div className="hof-list" role="radiogroup" aria-label={t('wrapup.targetLabel')}>
                    {candidates.length === 0 && <div className="hof-empty">{t('wrapup.noTargets')}</div>}
                    {candidates.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            role="radio"
                            aria-checked={target === c.id}
                            className={`hof-row${target === c.id ? ' is-picked' : ''}`}
                            onClick={() => setTarget(c.id)}
                        >
                            <span className={`hof-dot${c.online ? ' is-on' : ''}`} aria-hidden />
                            <span className="hof-row-text">
                                <span className="hof-row-title">{c.title}</span>
                                <span className="hof-row-meta">
                                    {[c.machineName, c.online ? t('wrapup.online') : t('wrapup.offline')].filter(Boolean).join(' · ')}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
                <label className="ns-label" htmlFor="handoff-note">{t('wrapup.noteLabel')}</label>
                <textarea
                    id="handoff-note"
                    className="ns-input hof-note"
                    rows={2}
                    value={note}
                    maxLength={2000}
                    placeholder={t('wrapup.notePlaceholder')}
                    onChange={(e) => setNote(e.target.value)}
                />
                <Checkbox className="hof-archive" checked={canArchive && archiveAfter} disabled={!canArchive} onCheckedChange={setArchiveAfter}>
                    {t('wrapup.archiveAfter')}
                </Checkbox>
                <p className="hof-hint">{canArchive ? t('wrapup.archiveAfterHint') : t('wrapup.archiveNeedsUpgrade')}</p>
                <div className="ns-actions vh-dialog-foot">
                    <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" disabled={!picked || busy} aria-busy={busy || undefined} onClick={() => void confirm()}>{t('wrapup.confirm')}</Button>
                </div>
            </div>
        </div>
    );
}
