/**
 * AgentInput — the composer. A big rounded auto-growing textarea + circular
 * send button, a clean status row (connection + always-visible context meter),
 * and model/permission/effort selectors on their own row.
 *
 * Sending: Enter sends (configurable via agentInputEnterToSend), Shift+Enter
 * inserts a newline. IME-safe: never sends while a composition is active.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { sync } from '@/sync/sync';
import { sessionAbort } from '@/sync/ops';
import {
    useSession,
    useSessionUsage,
    useSessionRunningTool,
    useRealtimeStatus,
    useSetting,
    storage,
} from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
} from '@/components/modelModeOptions';
import { ModeMenu } from './ModeMenu';
import { contextPercentUsed } from './format';
import './input.css';

const MAX_TA_HEIGHT = 200;

export function AgentInput({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const usage = useSessionUsage(sessionId);
    const runningTool = useSessionRunningTool(sessionId);
    const realtime = useRealtimeStatus();
    const enterToSend = useSetting('agentInputEnterToSend');

    const taRef = useRef<HTMLTextAreaElement>(null);
    const composingRef = useRef(false);
    const [text, setText] = useState(session?.draft ?? '');
    const [sending, setSending] = useState(false);
    const [aborting, setAborting] = useState(false);

    const flavor = session?.metadata?.flavor as any;
    const metadata = session?.metadata ?? null;
    const online = session?.presence === 'online';
    const connected = online && realtime === 'connected';
    const isWorking = session?.thinking === true || !!runningTool;

    // selectors
    const models = getAvailableModels(flavor, metadata, t as any);
    const permModes = getAvailablePermissionModes(flavor, metadata, t as any);
    const modelKey = session?.modelMode ?? null;
    const efforts = getEffortLevelsForModel(flavor, modelKey ?? 'default');
    const permKey = session?.permissionMode ?? null;
    const effortKey = session?.effortLevel ?? null;

    // context meter — always visible when we have a usage snapshot.
    const contextSize = usage?.contextSize ?? 0;
    const percentUsed = contextPercentUsed(contextSize);
    const meterTone = percentUsed >= 95 ? 'crit' : percentUsed >= 90 ? 'warn' : 'ok';

    // grow textarea
    useLayoutEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, MAX_TA_HEIGHT)}px`;
    }, [text]);

    // persist draft (debounced via storage's own normalization)
    useEffect(() => {
        const id = setTimeout(() => storage.getState().updateSessionDraft(sessionId, text), 400);
        return () => clearTimeout(id);
    }, [text, sessionId]);

    const doSend = async () => {
        const value = text.trim();
        if (!value || sending) return;
        setSending(true);
        setText('');
        storage.getState().updateSessionDraft(sessionId, null);
        try {
            await sync.sendMessage(sessionId, value, { source: 'chat' });
        } catch {
            // restore text on failure so the user doesn't lose it
            setText(value);
        } finally {
            setSending(false);
            requestAnimationFrame(() => taRef.current?.focus());
        }
    };

    const doAbort = async () => {
        if (aborting) return;
        setAborting(true);
        const started = Date.now();
        try {
            await sessionAbort(sessionId);
        } catch {
            /* ignore */
        } finally {
            const elapsed = Date.now() - started;
            if (elapsed < 300) await new Promise((r) => setTimeout(r, 300 - elapsed));
            setAborting(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // IME guard — never send mid-composition (critical for Chinese input).
        if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !(e.nativeEvent as any).isComposing) {
            if (enterToSend) {
                e.preventDefault();
                void doSend();
            }
        }
    };

    const setMode = (fn: 'updateSessionModelMode' | 'updateSessionPermissionMode' | 'updateSessionEffortLevel', key: string) => {
        storage.getState()[fn](sessionId, key);
    };

    const canSend = text.trim().length > 0 && !sending;

    return (
        <div className="ci" style={{ paddingBottom: 'max(var(--sp-3), env(safe-area-inset-bottom))' }}>
            {/* selector row */}
            <div className="ci-modes">
                <ModeMenu
                    label={t('session.chat.modelLabel' as any)}
                    options={models}
                    value={modelKey}
                    onChange={(k) => setMode('updateSessionModelMode', k)}
                />
                <ModeMenu
                    label={t('session.chat.permissionLabel' as any)}
                    options={permModes}
                    value={permKey}
                    onChange={(k) => setMode('updateSessionPermissionMode', k)}
                />
                {efforts.length > 0 && (
                    <ModeMenu
                        label={t('session.chat.effortLabel' as any)}
                        options={efforts}
                        value={effortKey}
                        onChange={(k) => setMode('updateSessionEffortLevel', k)}
                    />
                )}
            </div>

            {/* composer */}
            <div className="ci-composer">
                <textarea
                    ref={taRef}
                    className="ci-textarea"
                    value={text}
                    rows={1}
                    placeholder={t('session.inputPlaceholder' as any)}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onCompositionStart={() => (composingRef.current = true)}
                    onCompositionEnd={() => (composingRef.current = false)}
                    aria-label={t('common.message' as any)}
                />
                {isWorking ? (
                    <button
                        type="button"
                        className="ci-send ci-send--abort"
                        onClick={() => void doAbort()}
                        disabled={aborting}
                        aria-label={t('session.chat.stop' as any)}
                        title={t('session.chat.stop' as any)}
                    >
                        <Square size={16} fill="currentColor" />
                    </button>
                ) : (
                    <button
                        type="button"
                        className="ci-send"
                        onClick={() => void doSend()}
                        disabled={!canSend}
                        aria-label={t('session.chat.send' as any)}
                        title={t('session.chat.send' as any)}
                    >
                        <Send size={16} />
                    </button>
                )}
            </div>

            {/* status row — connection + always-visible context meter */}
            <div className="ci-status">
                <span className={`ci-conn ci-conn--${connected ? 'on' : 'off'}`}>
                    <span className="ci-conn-dot" />
                    {connected
                        ? t('session.chat.connected' as any)
                        : online
                            ? t('session.chat.reconnecting' as any)
                            : t('session.chat.disconnected' as any)}
                </span>
                <span className="ci-spacer" />
                <span className={`ci-meter ci-meter--${meterTone}`} title={t('session.chat.contextMeter' as any, { percent: percentUsed })}>
                    <span className="ci-meter-track">
                        <span className="ci-meter-fill" style={{ width: `${percentUsed}%` }} />
                    </span>
                    <span className="ci-meter-label">{t('session.chat.contextLeft' as any, { percent: 100 - percentUsed })}</span>
                </span>
                <span className="ci-hint">
                    {enterToSend ? t('session.chat.enterToSend' as any) : t('session.chat.shiftEnterToSend' as any)}
                </span>
            </div>
        </div>
    );
}
