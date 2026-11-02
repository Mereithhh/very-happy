/**
 * B-867 operator terminal — a terminal on the OWNER's machine, opened through
 * the server broker with this session's key only (spec
 * specs/2026-11-session-sharing-operator.md §2, §3.2, §12.2).
 *
 * Deliberately a focused pane, not WebTerminalScreen (a conflict hot zone
 * built on machine RPCs + the machine key, which an operator never holds). It
 * reuses the same renderer factory, font stack, sizes and lineHeight 1.0, and
 * speaks the v1 "attach" stream (tmux client output), which xterm renders
 * as-is. Lost on revoke: the buffer is cleared and the dialog closes at once.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTerminalRenderer, type TerminalRenderer } from '@/screens/terminal/renderer';
import { TERM_FONT, TERM_FONT_SIZE_COARSE, TERM_FONT_SIZE_FINE } from '@/screens/terminal/termFont';
import { TERM_THEME } from '@/screens/terminal/termTheme';
import { Button } from '@/ui';
import { toast } from '@/ui/Toast';
import { useTranslation } from '@/i18n/useTranslation';
import { OPERATOR_TERMINAL_DEFAULT_SIZE } from '@/sync/operatorProtocol';
import {
    onOperatorEvent,
    openOperatorData,
    operatorCall,
    sendOperatorTerminalClose,
    sendOperatorTerminalInput,
    sendOperatorTerminalResize,
} from '@/sync/operatorTransport';
import {
    acceptLive,
    applyOpen,
    b64ToBytes,
    initialStreamState,
    isOpenResult,
    readTerminalList,
    strToB64,
    type OperatorTerminalListEntry,
} from './operatorTerminalModel';
import { operatorErrorCode, operatorErrorCopy } from './operatorCopy';
import './operatorTerminal.css';

const IS_COARSE_POINTER = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export function OperatorTerminalDialog({ sessionId, owner, expiresAt, open, onOpenChange }: {
    sessionId: string;
    owner: string;
    expiresAt: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { t } = useTranslation();
    const [terminals, setTerminals] = useState<OperatorTerminalListEntry[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const list = readTerminalList(await operatorCall(sessionId, 'terminal.list', {}));
            setTerminals(list);
            return list;
        } catch (e) {
            setError(operatorErrorCopy(t, operatorErrorCode(e)));
            return [];
        }
    }, [sessionId, t]);

    const openNew = useCallback(async () => {
        setBusy(true); setError(null);
        try {
            const res = await operatorCall<unknown>(sessionId, 'terminal.open', { ...OPERATOR_TERMINAL_DEFAULT_SIZE });
            if (!isOpenResult(res)) throw new Error('bad open result');
            setTerminals((list) => list.some((x) => x.terminalId === res.terminalId) ? list : [...list, { terminalId: res.terminalId, kind: 'opened', openedAt: Date.now() }]);
            setActive(res.terminalId);
        } catch (e) {
            setError(operatorErrorCopy(t, operatorErrorCode(e)));
        } finally {
            setBusy(false);
        }
    }, [sessionId, t]);

    // On open: reattach to my existing terminals, else open a fresh one.
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setError(null);
        void refresh().then((list) => {
            if (!alive) return;
            if (list.length > 0) setActive((cur) => cur && list.some((x) => x.terminalId === cur) ? cur : list[0].terminalId);
            else void openNew();
        });
        return () => { alive = false; };
    }, [open, refresh, openNew]);

    // Revoke / downgrade / expiry: drop everything now, before the row re-read.
    useEffect(() => onOperatorEvent('revoked', (e) => {
        if (e.sessionId !== sessionId) return;
        setTerminals([]); setActive(null);
        // The session screen says why (one toast); this only closes the pane.
        if (open) onOpenChange(false);
    }), [sessionId, open, onOpenChange]);

    // A terminal ended on the owner's machine (exit, or the owner closed it): drop its
    // tab even when it is not the one on screen, and say why (B-867c, QA40 P2-4).
    useEffect(() => onOperatorEvent('exit', (e) => {
        if (e.sessionId !== sessionId) return;
        setTerminals((list) => list.filter((x) => x.terminalId !== e.terminalId));
        setActive((cur) => cur === e.terminalId ? null : cur);
        toast.show(e.reason === 'closed_on_machine' ? t('share.operator.terminalClosedOnMachine', { owner }) : t('share.operator.terminalEnded'));
    }), [sessionId, owner, t]);

    const kill = async (terminalId: string) => {
        try { await operatorCall(sessionId, 'terminal.kill', { terminalId }); }
        catch (e) { setError(operatorErrorCopy(t, operatorErrorCode(e))); return; }
        setTerminals((list) => list.filter((x) => x.terminalId !== terminalId));
        setActive((cur) => cur === terminalId ? null : cur);
    };

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay opt-overlay" />
                <Dialog.Content className="opt" aria-describedby={undefined}>
                    <div className="opt-head">
                        <Dialog.Title className="opt-title">{t('share.operator.terminalTitle', { owner })}</Dialog.Title>
                        <div className="opt-tabs" role="tablist" aria-label={t('share.operator.terminal')}>
                            {terminals.map((term, i) => (
                                <button key={term.terminalId} type="button" role="tab" aria-selected={active === term.terminalId} className="opt-tab" onClick={() => setActive(term.terminalId)}>
                                    {term.kind === 'attached' ? t('share.operator.event.terminalAttach') : `${t('share.operator.terminal')} ${i + 1}`}
                                </button>
                            ))}
                        </div>
                        <Button type="button" variant="ghost" size="sm" leftIcon={<Plus size={14} />} loading={busy} onClick={() => void openNew()}>{t('share.operator.terminalNew')}</Button>
                        {active && terminals.find((x) => x.terminalId === active)?.kind === 'opened' && (
                            <Button type="button" variant="ghost" size="sm" onClick={() => void kill(active)}>{t('share.operator.terminalKill')}</Button>
                        )}
                        <Dialog.Close className="vh-dialog-close opt-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                    </div>
                    <p className="opt-banner" role="status"><ShieldAlert size={14} aria-hidden />{t('share.operator.banner', { owner, expiry: expiresAt })}</p>
                    {error && <p className="opt-error" role="alert">{error}</p>}
                    <div className="opt-body">
                        {active
                            ? <OperatorTerminalPane key={active} sessionId={sessionId} terminalId={active} onError={(code) => setError(operatorErrorCopy(t, code))} />
                            : <p className="opt-empty">{busy ? t('share.operator.terminalOpening') : ''}</p>}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function OperatorTerminalPane({ sessionId, terminalId, onError }: {
    sessionId: string;
    terminalId: string;
    onError: (code: string) => void;
}) {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const errorRef = useRef(onError);
    errorRef.current = onError;

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        let disposed = false;
        let state = initialStreamState();
        // Writes are serialized: decrypting is async, the screen must not reorder.
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
        renderer.fit();

        const offOutput = onOperatorEvent('output', (e) => {
            if (e.sessionId !== sessionId || e.terminalId !== terminalId) return;
            enqueue(async () => {
                const verdict = acceptLive(state, e.seq);
                if (!verdict.write || disposed) return;
                state = verdict.next;
                const plain = await openOperatorData(sessionId, e.data);
                if (plain && !disposed) renderer.write(b64ToBytes(plain));
            });
        });
        const offRevoked = onOperatorEvent('revoked', (e) => {
            // Clear what the operator saw — the access is gone.
            if (e.sessionId === sessionId) renderer.reset();
        });

        const input = renderer.onData((d) => { void sendOperatorTerminalInput(sessionId, terminalId, strToB64(d)); });

        enqueue(async () => {
            try {
                const res = await operatorCall<unknown>(sessionId, 'terminal.attach', { terminalId, cols: renderer.cols, rows: renderer.rows });
                if (disposed || !isOpenResult(res)) return;
                const applied = applyOpen(state, res);
                state = applied.next;
                if (applied.reset) renderer.reset();
                for (const data of applied.writes) renderer.write(b64ToBytes(data));
                renderer.focusInput();
            } catch (e) {
                if (!disposed) errorRef.current(operatorErrorCode(e));
            }
        });

        let lastSize = `${renderer.cols}x${renderer.rows}`;
        const resizeObserver = new ResizeObserver(() => {
            if (disposed) return;
            renderer.fit();
            const size = `${renderer.cols}x${renderer.rows}`;
            if (size === lastSize) return;
            lastSize = size;
            sendOperatorTerminalResize(sessionId, terminalId, renderer.cols, renderer.rows);
        });
        resizeObserver.observe(mount);

        return () => {
            disposed = true;
            resizeObserver.disconnect();
            offOutput(); offRevoked();
            input.dispose();
            sendOperatorTerminalClose(sessionId, terminalId);
            renderer.dispose();
        };
    }, [sessionId, terminalId]);

    return <div className="opt-term" ref={mountRef} />;
}
