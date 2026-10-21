/**
 * B-701 `/s/:linkId#secret` — the read-only page a share link opens (spec
 * specs/2026-10-session-sharing-tiers.md §4.3). No account, no socket, no
 * key: the secret from the fragment goes in `x-share-secret`, the server
 * answers with projected + masked records, and the page polls so a revoke or
 * expiry clears the transcript within 5 s and says why (never a blank page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { VeryHappyMark, EmptyState, Button, StatusDot, QuickThemeToggle } from '@/ui';
import { BRAND } from '@/app/brand';
import { getServerUrl } from '@/sync/serverConfig';
import { PublicLinkInfoSchema, PublicLinkMessagesSchema, type PublicLinkInfo } from '@/sync/sessionShareTypes';
import { ActivityMessages } from '@/screens/session/ActivityMessages';
import { ReadOnlyTranscriptContext } from '@/screens/session/readOnlyTranscript';
import { useTranslation } from '@/i18n/useTranslation';
import { mergeRecords, messagesFromRecords, phaseForStatus, pollFailureClears, pollIntervalMs, secretFromHash, type SharedLinkPhase, type SharedLinkRecord } from './sharedLink';
import { ensureShareLinkMeta } from './sharedLink';
import '@/screens/session/chatlist.css';
import './sharedLink.css';

class LinkHttpError extends Error {
    constructor(readonly status: number) { super(`http_${status}`); }
}

async function fetchLink<T>(path: string, secret: string, parse: (v: unknown) => T): Promise<T> {
    // Anonymous by design: never send this browser's Very Happy credentials (Lead security review).
    const headers: Record<string, string> = { 'x-share-secret': secret };
    const response = await fetch(`${getServerUrl().replace(/\/$/, '')}${path}`, { headers, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' });
    if (!response.ok) throw new LinkHttpError(response.status);
    return parse(await response.json());
}

const STATE_COPY = {
    invalid: ['share.page.invalidTitle', 'share.page.invalidBody'],
    gone: ['share.page.goneTitle', 'share.page.goneBody'],
    rateLimited: ['share.page.rateLimitedTitle', 'share.page.rateLimitedBody'],
    error: ['share.page.errorTitle', 'share.page.errorBody'],
} as const;

function formatTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function SharedLinkScreen() {
    const { t } = useTranslation();
    const { linkId = '' } = useParams();
    const secret = useMemo(() => secretFromHash(window.location.hash), []);
    const [phase, setPhase] = useState<SharedLinkPhase>(secret ? 'loading' : 'invalid');
    const [info, setInfo] = useState<PublicLinkInfo | null>(null);
    const [records, setRecords] = useState<SharedLinkRecord[]>([]);
    const [attempt, setAttempt] = useState(0);
    const lastSeq = useRef(0);

    // Belt and braces for noindex / no-referrer when the document did not come with our headers.
    useEffect(() => ensureShareLinkMeta(document), []);

    // Any failure after load (410 on a poll) wipes what was shown: a revoked link must not leave content behind.
    const fail = useCallback((error: unknown) => {
        lastSeq.current = 0;
        setRecords([]);
        setInfo(null);
        setPhase(error instanceof LinkHttpError ? phaseForStatus(error.status) : 'error');
    }, []);

    const pull = useCallback(async () => {
        if (!secret) return;
        for (let page = 0; page < 50; page++) {
            const result = await fetchLink(`/v1/public/share-links/${encodeURIComponent(linkId)}/messages?after_seq=${lastSeq.current}&limit=200`, secret, (v) => PublicLinkMessagesSchema.parse(v));
            lastSeq.current = Math.max(lastSeq.current, result.lastSeq);
            if (result.messages.length) setRecords((current) => mergeRecords(current, result.messages));
            if (!result.hasMore) return;
        }
    }, [linkId, secret]);

    useEffect(() => {
        if (!secret) return;
        let cancelled = false;
        setPhase('loading');
        (async () => {
            try {
                const loaded = await fetchLink(`/v1/public/share-links/${encodeURIComponent(linkId)}`, secret, (v) => PublicLinkInfoSchema.parse(v));
                if (cancelled) return;
                setInfo(loaded);
                await pull();
                if (!cancelled) setPhase('ready');
            } catch (error) {
                if (!cancelled) fail(error);
            }
        })();
        return () => { cancelled = true; };
    }, [linkId, secret, pull, fail, attempt]);

    // Poll while ready: live pages pick up new messages, every page re-validates the link.
    useEffect(() => {
        if (phase !== 'ready' || !info) return;
        let busy = false;
        const tick = () => {
            if (busy || document.hidden) return;
            busy = true;
            pull()
                .catch((error) => { if (pollFailureClears(error instanceof LinkHttpError ? error.status : null)) fail(error); })
                .finally(() => { busy = false; });
        };
        const timer = window.setInterval(tick, pollIntervalMs(info.scope));
        const onVisible = () => { if (!document.hidden) tick(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, [phase, info, pull, fail]);

    const messages = useMemo(() => messagesFromRecords(records), [records]);
    const title = info?.session.title || t('share.page.untitled');
    useEffect(() => { document.title = `${phase === 'ready' ? title : t('share.page.untitled')} — ${BRAND.name}`; }, [phase, title, t]);

    return (
        <div className="slk">
            <header className="slk-head">
                <Link className="slk-brand" to="/welcome" aria-label={t('share.page.home')}><VeryHappyMark size={22} /></Link>
                {phase === 'ready' && info ? (
                    <div className="slk-meta">
                        <h1 className="slk-title">{title}</h1>
                        <p className="slk-sub">
                            <span>{t('share.page.sharedBy', { owner: info.owner.displayName })}</span>
                            <span className="slk-chip">{t('share.page.readOnly')}</span>
                            {info.scope === 'live'
                                ? <span className="slk-live"><StatusDot status="connected" pulse size={6} />{t('share.page.live')}</span>
                                : info.snapshotAt && <span>{t('share.page.snapshotAt', { time: formatTime(info.snapshotAt) })}</span>}
                            {info.session.project && <span className="slk-mono">{info.session.project}</span>}
                        </p>
                    </div>
                ) : <div className="slk-meta" />}
                <QuickThemeToggle />
            </header>

            {phase === 'ready' && (
                <main className="cl slk-chat">
                    <div className="cl-scroll">
                        <div className="cl-inner">
                            {messages.length === 0
                                ? <p className="slk-empty">{t('share.page.empty')}</p>
                                : <ReadOnlyTranscriptContext.Provider value><ActivityMessages messages={messages} sessionId={`share-link:${linkId}`} subagentNavigation="inline" /></ReadOnlyTranscriptContext.Provider>}
                            <p className="slk-foot">
                                {t('share.page.masked')}
                                {info?.expiresAt ? ` · ${t('share.page.expires', { time: formatTime(info.expiresAt) })}` : ''}
                            </p>
                        </div>
                    </div>
                </main>
            )}

            {phase === 'loading' && <main className="slk-state" role="status"><EmptyState compact title={t('share.page.loading')} /></main>}
            {phase !== 'ready' && phase !== 'loading' && (
                <main className="slk-state" role="alert">
                    <EmptyState
                        title={t(STATE_COPY[phase][0])}
                        description={t(STATE_COPY[phase][1])}
                        actions={phase === 'error' ? <Button variant="primary" size="md" onClick={() => setAttempt((n) => n + 1)}>{t('share.page.retry')}</Button> : undefined}
                    />
                </main>
            )}
        </div>
    );
}
