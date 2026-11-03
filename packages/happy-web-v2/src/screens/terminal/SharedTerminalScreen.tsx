/**
 * SharedTerminalScreen (B-878) — a terminal someone shared with me, at
 * `/shared/terminal/:grantId`. Everything goes through the server broker with
 * the grant's own stream key (never the owner's machine key, never the relay).
 *
 *  - view only: the pane keeps the OWNER's columns (the attach answer and the
 *    `share-terminal-geometry` pushes say how many) and is scaled down to fit;
 *    no keystroke, paste or resize ever leaves this page (the server drops
 *    them anyway). The soft keyboard never opens.
 *  - can operate: a normal fitted pane — typing and resizing go to the owner's
 *    terminal like another of the owner's devices.
 *
 * Revoke / expiry / leave: the buffer is cleared at once and the page says why.
 * Deliberately its own small screen, not WebTerminalScreen (a conflict hot
 * zone built on machine RPCs + the machine key). Same renderer factory, font,
 * sizes and lineHeight 1.0 (iron rule 9), always-dark theme.
 */
import { Eye, Keyboard, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createTerminalRenderer, type TerminalRenderer } from './renderer';
import { TERM_FONT, TERM_FONT_SIZE_COARSE, TERM_FONT_SIZE_FINE } from './termFont';
import { TERM_THEME } from './termTheme';
import { BackButton } from '@/app/BackButton';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { formatShareTime } from '@/screens/session/shareFormat';
import {
    onTerminalShareEvent,
    openShareData,
    sendShareTerminalClose,
    sendShareTerminalInput,
    sendShareTerminalResize,
    terminalShareCall,
    useIncomingTerminalShares,
    useTerminalShares,
} from '@/sync/terminalSharesStore';
import { TerminalShareRpcError, viewOnlyScale, type IncomingTerminalShare } from '@/sync/terminalShareTypes';
import { acceptLive, applyOpen, b64ToBytes, initialStreamState, isOpenResult, strToB64 } from '@/screens/session/operatorTerminalModel';
import './terminalShare.css';

const IS_COARSE_POINTER = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

type T = ReturnType<typeof useTranslation>['t'];

export function terminalShareErrorCopy(t: T, code: string, owner: string): string {
    switch (code) {
        case 'cli_upgrade_required':
        case 'machine_unsupported': return t('share.terminal.errors.upgrade');
        case 'machine_offline': return t('share.terminal.errors.offline');
        case 'not_shared': return t('share.terminal.errors.notShared');
        case 'terminal_gone': return t('share.terminal.ended', { owner });
        case 'server_too_old': return t('share.terminal.errors.serverTooOld');
        case 'key_unavailable': return t('share.terminal.errors.key');
        case 'rate_limited': return t('share.terminal.errors.rateLimited');
        default: return t('share.terminal.errors.generic', { error: code });
    }
}

function codeOf(e: unknown): string {
    return e instanceof TerminalShareRpcError ? e.code : 'rpc_failed';
}

export function SharedTerminalScreen() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { grantId = '' } = useParams<{ grantId: string }>();
    const incoming = useIncomingTerminalShares();
    const loaded = useTerminalShares((s) => s.incomingLoaded);
    const respond = useTerminalShares((s) => s.respond);
    const share = incoming.find((g) => g.id === grantId) ?? null;
    const [ended, setEnded] = useState<'revoked' | null>(null);

    useEffect(() => onTerminalShareEvent('revoked', (e) => { if (e.grantId === grantId) setEnded('revoked'); }), [grantId]);

    if (ended) return <SharedTerminalEmpty text={t('share.terminal.revoked')} onHome={() => navigate('/')} />;
    if (!share) return loaded ? <SharedTerminalEmpty text={t('share.terminal.notFound')} onHome={() => navigate('/')} /> : <SharedTerminalEmpty text={t('common.loading')} />;

    const title = share.title || t('share.terminal.untitled');
    const expiry = formatShareTime(share.expiresAt);
    return (
        <div className="sts">
            <header className="sts-head">
                <BackButton />
                <span className="sts-title" title={title}>{title}</span>
                <span className="sts-role">{share.role === 'operator' ? t('share.roleOperator') : t('share.roleViewer')}</span>
            </header>
            <p className={`sts-banner${share.role === 'operator' ? ' sts-banner--operator' : ''}`} role="status">
                {share.role === 'operator' ? <Keyboard size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                {share.role === 'operator'
                    ? t('share.terminal.bannerOperator', { owner: share.owner.displayName, expiry })
                    : t('share.terminal.bannerViewer', { owner: share.owner.displayName, expiry })}
            </p>
            {share.status === 'pending' ? (
                <div className="sts-empty">
                    <p>{t('share.terminal.invite', { owner: share.owner.displayName, title })}</p>
                    <Button type="button" variant="primary" size="md" onClick={() => void respond(share.id, true)}>{t('share.invites.accept')}</Button>
                </div>
            ) : (
                <SharedTerminalPane key={`${share.id}:${share.role}`} share={share} />
            )}
        </div>
    );
}

function SharedTerminalEmpty({ text, onHome }: { text: string; onHome?: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="sts">
            <header className="sts-head"><BackButton /></header>
            <div className="sts-empty" role="status">
                <p>{text}</p>
                {onHome && <Button type="button" variant="secondary" size="md" onClick={onHome}>{t('share.terminal.backHome')}</Button>}
            </div>
        </div>
    );
}

function SharedTerminalPane({ share }: { share: IncomingTerminalShare }) {
    const { t } = useTranslation();
    const viewOnly = share.role !== 'operator';
    const grantId = share.id;
    const boxRef = useRef<HTMLDivElement | null>(null);
    const mountRef = useRef<HTMLDivElement | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [connecting, setConnecting] = useState(true);
    const [generation, setGeneration] = useState(0);
    const resync = useCallback(() => { setError(null); setGeneration((g) => g + 1); }, []);

    useEffect(() => {
        const mount = mountRef.current;
        const box = boxRef.current;
        if (!mount || !box) return;
        let disposed = false;
        let state = initialStreamState();
        let geometry: { cols: number; rows: number } | null = null;
        let chain: Promise<void> = Promise.resolve();
        const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(() => {}); };
        const renderer: TerminalRenderer = createTerminalRenderer('xterm', {
            mount,
            fontFamily: TERM_FONT,
            fontSize: IS_COARSE_POINTER ? TERM_FONT_SIZE_COARSE : TERM_FONT_SIZE_FINE,
            theme: TERM_THEME,
            scrollback: 5000,
            coarsePointer: IS_COARSE_POINTER,
        });
        if (viewOnly) {
            // Nothing typed here may reach the owner's shell, and a tap must not open the soft keyboard.
            if (renderer.raw) renderer.raw.options.disableStdin = true;
            const input = renderer.inputElement();
            input?.setAttribute('inputmode', 'none');
            input?.setAttribute('readonly', '');
        } else {
            renderer.fit();
        }

        /** View only: render at the owner's size, scaled down to the box. */
        const applyGeometry = () => {
            if (!viewOnly || !geometry) return;
            renderer.resizeTo(geometry.cols, geometry.rows);
            requestAnimationFrame(() => {
                if (disposed) return;
                mount.style.transform = '';
                const natural = mount.scrollWidth;
                const scale = viewOnlyScale(natural, box.clientWidth);
                mount.style.transform = scale < 1 ? `scale(${scale})` : '';
            });
        };

        const offOutput = onTerminalShareEvent('output', (e) => {
            if (e.grantId !== grantId) return;
            enqueue(async () => {
                const verdict = acceptLive(state, e.seq);
                if (!verdict.write || disposed) return;
                state = verdict.next;
                const plain = await openShareData(grantId, e.data);
                if (typeof plain === 'string' && !disposed) renderer.write(b64ToBytes(plain));
            });
        });
        const offRevoked = onTerminalShareEvent('revoked', (e) => { if (e.grantId === grantId) renderer.reset(); });
        const offExit = onTerminalShareEvent('exit', (e) => {
            if (e.grantId === grantId) setError(t('share.terminal.ended', { owner: share.owner.displayName }));
        });
        // The owner's pane changed size: re-fit and take a fresh snapshot at the new width.
        const offGeometry = onTerminalShareEvent('geometry', (e) => {
            if (e.grantId !== grantId || !viewOnly) return;
            geometry = { cols: e.cols, rows: e.rows };
            enqueue(async () => { await attach(true); });
        });

        const input = viewOnly ? null : renderer.onData((d) => { void sendShareTerminalInput(grantId, strToB64(d)); });

        const attach = async (fresh: boolean) => {
            try {
                const params = viewOnly ? {} : { cols: renderer.cols, rows: renderer.rows };
                const res = await terminalShareCall<unknown>(grantId, 'attach', fresh ? { ...params, resub: true } : params);
                if (disposed || !isOpenResult(res)) return;
                const g = (res as { geometry?: { cols?: unknown; rows?: unknown } }).geometry;
                if (viewOnly && g && typeof g.cols === 'number' && typeof g.rows === 'number') geometry = { cols: g.cols, rows: g.rows };
                applyGeometry();
                // A fresh snapshot after a geometry change replaces the screen.
                const applied = applyOpen(fresh ? initialStreamState() : state, res);
                state = applied.next;
                if (applied.reset) renderer.reset();
                for (const data of applied.writes) {
                    const plain = typeof data === 'string' ? data : '';
                    renderer.write(b64ToBytes(plain));
                }
                setConnecting(false);
                setError(null);
                if (!viewOnly) renderer.focusInput();
            } catch (e) {
                if (!disposed) { setConnecting(false); setError(terminalShareErrorCopy(t, codeOf(e), share.owner.displayName)); }
            }
        };
        enqueue(() => attach(false));

        let lastSize = `${renderer.cols}x${renderer.rows}`;
        const resizeObserver = new ResizeObserver(() => {
            if (disposed) return;
            if (viewOnly) { applyGeometry(); return; }
            renderer.fit();
            const size = `${renderer.cols}x${renderer.rows}`;
            if (size === lastSize) return;
            lastSize = size;
            sendShareTerminalResize(grantId, renderer.cols, renderer.rows);
        });
        resizeObserver.observe(box);

        return () => {
            disposed = true;
            resizeObserver.disconnect();
            offOutput(); offRevoked(); offExit(); offGeometry();
            input?.dispose();
            sendShareTerminalClose(grantId);
            renderer.dispose();
        };
    }, [grantId, viewOnly, generation, share.owner.displayName, t]);

    return (
        <>
            {error && (
                <p className="sts-error" role="alert">
                    {error}{' '}
                    <Button type="button" variant="ghost" size="sm" leftIcon={<RefreshCw size={13} />} onClick={resync}>{t('share.terminal.resync')}</Button>
                </p>
            )}
            <div className="sts-body" ref={boxRef} aria-busy={connecting} data-view-only={viewOnly ? 'true' : undefined}>
                <div className={`sts-term${viewOnly ? ' sts-term--fixed' : ''}`} ref={mountRef} />
            </div>
        </>
    );
}
