/**
 * BtwPanel — the `/btw` side-question panel (B-279). Lives in the session's
 * right-hand aside (same geometry as FilesPanel). Exchanges come from
 * btwStore (memory-only, per session); the store owns the ask/poll loop so
 * closing the panel never abandons a running question.
 *
 * Gate: any structured Claude session can host the panel, but only a wrapper
 * advertising `claude-btw-v1` answers — older CLIs get an upgrade notice and a
 * disabled composer (铁律 14: capability per session, never per machine).
 */
import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion, Send, Square, Trash2, X } from 'lucide-react';
import { useSession, useSetting } from '@/sync/storage';
import { btwStore, useBtwSession, type BtwExchange } from '@/sync/btwStore';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { useImeGuard } from '@/utils/ime';
import { Markdown, MarkdownPathProvider } from './Markdown';
import { useElapsedSeconds } from './useElapsed';
import { supportsBtw } from './btwCommand';
import { resolveBtwComposerKey } from './btwSubmitKey';
import './btw.css';

function clock(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function RunningRow({ exchange }: { exchange: BtwExchange }) {
    const { t } = useTranslation();
    const seconds = useElapsedSeconds(exchange.startedAt);
    return (
        <div className="btw-running" role="status" aria-live="polite">
            <StatusDot status="thinking" pulse size={7} />
            <span>{t('session.btw.thinking')}</span>
            <span className="btw-meta">{seconds}s</span>
        </div>
    );
}

function ExchangeView({ exchange }: { exchange: BtwExchange }) {
    const { t } = useTranslation();
    return (
        <div className={`btw-item btw-item--${exchange.status}`}>
            <div className="btw-q">
                <div className="btw-q-text">{exchange.question}</div>
                <time className="btw-meta" dateTime={new Date(exchange.startedAt).toISOString()}>{clock(exchange.startedAt)}</time>
            </div>
            <div className="btw-a">
                {exchange.answer && <Markdown text={exchange.answer} />}
                {exchange.status === 'running' && <RunningRow exchange={exchange} />}
                {exchange.status === 'error' && (
                    <div className="btw-note btw-note--error">{t('session.btw.failed', { error: exchange.error ?? '' })}</div>
                )}
                {exchange.status === 'cancelled' && <div className="btw-note">{t('session.btw.cancelled')}</div>}
                {exchange.status === 'done' && !exchange.hadContext && (
                    <div className="btw-note">{t('session.btw.noContext')}</div>
                )}
            </div>
        </div>
    );
}

export function BtwPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const { exchanges, draft } = useBtwSession(sessionId);
    const supported = supportsBtw(session);
    const online = session?.presence === 'online';
    const running = exchanges.find((e) => e.status === 'running');
    const ime = useImeGuard();
    const enterToSend = useSetting('agentInputEnterToSend');
    const taRef = useRef<HTMLTextAreaElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    // The textarea is controlled by LOCAL state only (a per-keystroke round
    // trip through the store dropped characters under fast typing). The store
    // draft is the hand-off channel: read at mount / when another path (the
    // composer's `/btw q` on an old CLI) parks text there, written back on
    // unmount so close/reopen keeps what was typed.
    const [draftLocal, setDraftLocal] = useState(draft);
    const draftLocalRef = useRef(draftLocal);
    draftLocalRef.current = draftLocal;
    useEffect(() => {
        if (draft && draft !== draftLocalRef.current) setDraftLocal(draft);
    }, [draft]);
    useEffect(() => () => { btwStore.getState().setDraft(sessionId, draftLocalRef.current); }, [sessionId]);
    useEffect(() => {
        if (supported) requestAnimationFrame(() => taRef.current?.focus());
    }, [supported, sessionId]);
    // Follow the newest text (progressive answers grow the last item).
    const lastAnswerLength = exchanges.length ? exchanges[exchanges.length - 1].answer.length : 0;
    useEffect(() => {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [exchanges.length, lastAnswerLength]);

    const canAsk = supported && online && !running && draftLocal.trim().length > 0;
    const submit = () => {
        // A send-button tap while a composition is still open would ship the
        // half-composed text; the key path is guarded per event below.
        if (!canAsk || ime.isComposing()) return;
        const question = draftLocal;
        setDraftLocal('');
        btwStore.getState().setDraft(sessionId, '');
        void btwStore.getState().ask(sessionId, question);
        requestAnimationFrame(() => taRef.current?.focus());
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const action = resolveBtwComposerKey({
            key: e.key,
            shiftKey: e.shiftKey,
            guarded: ime.isGuarded(e),
            enterToSend,
        });
        if (action === 'submit') {
            e.preventDefault();
            submit();
        }
    };

    return (
        <div className="btw">
            <div className="btw-head">
                <MessageCircleQuestion size={15} className="btw-head-icon" />
                <span className="btw-title">{t('session.btw.title')}</span>
                <span className="btw-head-hint">{t('session.btw.subtitle')}</span>
                {exchanges.length > 0 && !running && (
                    <button
                        type="button"
                        className="btw-icon"
                        onClick={() => btwStore.getState().clear(sessionId)}
                        aria-label={t('session.btw.clear')}
                        title={t('session.btw.clear')}
                    >
                        <Trash2 size={14} />
                    </button>
                )}
                <button type="button" className="btw-icon" onClick={onClose} aria-label={t('session.btw.close')} title={t('session.btw.close')}>
                    <X size={16} />
                </button>
            </div>

            <div className="btw-body" ref={bodyRef}>
                {exchanges.length === 0 ? (
                    <div className="btw-empty">
                        <div className="btw-empty-title">{t('session.btw.emptyTitle')}</div>
                        <div className="btw-empty-desc">{t('session.btw.emptyDesc')}</div>
                    </div>
                ) : (
                    <MarkdownPathProvider sessionId={sessionId}>
                        {exchanges.map((exchange) => <ExchangeView key={exchange.id} exchange={exchange} />)}
                    </MarkdownPathProvider>
                )}
            </div>

            <div className="btw-foot">
                {!supported ? (
                    <div className="btw-note btw-note--block">{t('session.btw.unsupported')}</div>
                ) : !online ? (
                    <div className="btw-note btw-note--block">{t('session.btw.offline')}</div>
                ) : null}
                <div className={`btw-composer${supported && online ? '' : ' is-disabled'}`}>
                    <textarea
                        ref={taRef}
                        className="btw-textarea"
                        rows={2}
                        value={draftLocal}
                        disabled={!supported}
                        placeholder={enterToSend ? t('session.btw.placeholder') : t('session.btw.placeholderShiftEnter')}
                        onChange={(e) => setDraftLocal(e.target.value)}
                        onKeyDown={onKeyDown}
                        onCompositionStart={ime.onCompositionStart}
                        onCompositionEnd={ime.onCompositionEnd}
                        aria-label={t('session.btw.title')}
                    />
                    {running ? (
                        <button
                            type="button"
                            className="btw-send btw-send--stop"
                            onClick={() => void btwStore.getState().cancel(sessionId)}
                            aria-label={t('session.btw.cancel')}
                            title={t('session.btw.cancel')}
                        >
                            <Square size={14} />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="btw-send"
                            onClick={submit}
                            disabled={!canAsk}
                            aria-label={t('session.btw.send')}
                            title={t('session.btw.send')}
                        >
                            <Send size={15} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
