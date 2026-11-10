/**
 * MainAgentPanel — the text view of THE main agent (B-916a), shared by the
 * desktop drawer and the phone's /main-agent page. Text only (Owner 11-11: no
 * voice in phase 1 — /assistant keeps its voice form).
 *
 * States come from resolveMainAgent: enable (pick a machine; recommended =
 * likely always-on), upgrade (old CLI: hint, never spawn), starting (account
 * already points at a machine whose session is gone: re-spawn there once),
 * ready (transcript + composer; offline machine → message queues).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bot, ExternalLink, RotateCcw, SendHorizontal, Settings, X } from 'lucide-react';
import { Button, Spinner, StatusDot } from '@/ui';
import { Summary } from '@/ui/Summary';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { machineLabel } from '@/utils/machineUtils';
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Markdown } from '@/screens/session/Markdown';
import { derivePendingPermission, deriveTranscript } from '@/assistant/assistantView';
import { hasMainAgentGates, mainAgentDot, mainAgentStatusDot, MAIN_AGENT_OTHER_MACHINE_ERROR, type MainAgentState } from '@/assistant/mainAgent';
import { mainAgentCopy, type MainAgentCopy } from '@/assistant/mainAgentCopy';
import { useMainAgentActions } from '@/assistant/useMainAgent';
import { useMainAgentStore } from '@/assistant/mainAgentStore';
import type { Machine } from '@/sync/storageTypes';
import './mainAgent.css';

export function MainAgentPanel({ state, variant, onClose }: {
    state: MainAgentState;
    variant: 'drawer' | 'page';
    onClose: () => void;
}) {
    const { lang } = useTranslation();
    const copy = mainAgentCopy(lang);
    const navigate = useNavigate();
    const actions = useMainAgentActions();
    const dot = mainAgentDot(state);
    const session = state.kind === 'ready' ? state.session : null;
    const machine = state.kind === 'ready' ? state.machine : state.kind === 'upgrade' || state.kind === 'starting' ? state.machine : null;

    // starting: the account points at a machine without a live session → re-spawn there ONCE
    const startedRef = useRef<string | null>(null);
    useEffect(() => {
        if (state.kind !== 'starting' || actions.spawning || actions.spawnError) return;
        if (startedRef.current === state.machine.id) return;
        startedRef.current = state.machine.id;
        void actions.enable(state.machine.id);
    }, [state, actions]);

    const onNewConversation = useCallback(async () => {
        if (!session || !machine) return;
        if (!(await Modal.confirm(copy.newConversationConfirm))) return;
        await actions.replace(machine.id, session.id);
    }, [session, machine, actions, copy]);

    const statusText = { idle: copy.statusIdle, thinking: copy.statusThinking, offline: copy.statusOffline, attention: copy.statusAttention, none: copy.statusNone }[dot];
    const dotStatus = mainAgentStatusDot(dot);

    return (
        <section className="ma-panel" data-variant={variant} aria-label={copy.title}>
            <header className="ma-head">
                {variant === 'page' && (
                    <button type="button" className="ma-icon-btn" onClick={onClose} aria-label={copy.back} title={copy.back}><ArrowLeft size={18} /></button>
                )}
                <div className="ma-head-title">
                    <Bot size={16} aria-hidden />
                    <span className="ma-head-name">{copy.title}</span>
                    {state.kind !== 'loading' && (
                        <span className="ma-head-status">
                            <StatusDot status={dotStatus} pulse={dot === 'thinking'} title={statusText} />
                            <span className="ma-head-status-text">{statusText}</span>
                            {machine && <span className="ma-head-machine mono">· {machineLabel(machine)}</span>}
                        </span>
                    )}
                </div>
                <div className="ma-head-actions">
                    {session && (
                        <button type="button" className="ma-icon-btn" onClick={() => void onNewConversation()} disabled={actions.spawning} aria-label={copy.newConversation} title={copy.newConversation}>
                            {actions.spawning ? <Spinner size={16} /> : <RotateCcw size={16} />}
                        </button>
                    )}
                    {session && (
                        <button type="button" className="ma-icon-btn" onClick={() => navigate(`/session/${session.id}`)} aria-label={copy.openSession} title={copy.openSession}><ExternalLink size={16} /></button>
                    )}
                    <button type="button" className="ma-icon-btn" onClick={() => navigate('/settings/main-agent')} aria-label={copy.openSettings} title={copy.openSettings}><Settings size={16} /></button>
                    {variant === 'drawer' && (
                        <button type="button" className="ma-icon-btn" onClick={onClose} aria-label={copy.close} title={copy.close}><X size={17} /></button>
                    )}
                </div>
            </header>
            <MainAgentBody state={state} copy={copy} actions={actions} />
        </section>
    );
}

function MainAgentBody({ state, copy, actions }: { state: MainAgentState; copy: MainAgentCopy; actions: ReturnType<typeof useMainAgentActions> }) {
    const navigate = useNavigate();
    if (state.kind === 'loading') return <div className="ma-center"><Spinner size={20} /></div>;
    if (state.kind === 'ready') return <MainAgentConversation sessionId={state.session.id} gates={hasMainAgentGates(state.session)} offlineMachine={state.offline ? (state.machine ? machineLabel(state.machine) : copy.statusOffline) : null} copy={copy} />;
    if (state.kind === 'upgrade') {
        return (
            <div className="ma-gate" role="status">
                <h2 className="ma-gate-title">{copy.upgradeTitle}</h2>
                <p className="ma-gate-body">{copy.upgradeBody(machineLabel(state.machine), state.version ?? copy.unknownVersion)}</p>
                <Button variant="secondary" onClick={() => navigate(`/machine/${state.machine.id}`)}>{copy.upgradeOpenMachine}</Button>
            </div>
        );
    }
    if (state.kind === 'starting') {
        return (
            <div className="ma-gate" role="status">
                {actions.spawnError ? (
                    <>
                        <h2 className="ma-gate-title">{copy.startFailed}</h2>
                        <SpawnError error={actions.spawnError} copy={copy} />
                        <Button variant="primary" loading={actions.spawning} onClick={() => void actions.enable(state.machine.id)}>{copy.retry}</Button>
                    </>
                ) : (
                    <p className="ma-gate-body"><Spinner size={16} /> {copy.starting(machineLabel(state.machine))}</p>
                )}
            </div>
        );
    }
    return <MainAgentEnable candidates={state.candidates} recommended={state.recommended} copy={copy} actions={actions} />;
}

function SpawnError({ error, copy }: { error: string; copy: MainAgentCopy }) {
    const navigate = useNavigate();
    if (error !== MAIN_AGENT_OTHER_MACHINE_ERROR) return <p className="ma-gate-body tg-error">{error}</p>;
    return (
        <p className="ma-gate-body tg-error">
            {copy.otherMachine}
            <button type="button" className="ma-link-btn" onClick={() => navigate('/settings/main-agent')}>{copy.openSettings}</button>
        </p>
    );
}

function MainAgentEnable({ candidates, recommended, copy, actions }: { candidates: Machine[]; recommended: Machine | null; copy: MainAgentCopy; actions: ReturnType<typeof useMainAgentActions> }) {
    const navigate = useNavigate();
    const [picked, setPicked] = useState<string | null>(recommended?.id ?? null);
    const chosen = picked && candidates.some((m) => m.id === picked) ? picked : recommended?.id ?? null;
    return (
        <div className="ma-gate">
            <h2 className="ma-gate-title">{copy.enableTitle}</h2>
            <p className="ma-gate-body">{copy.enableBody}</p>
            {candidates.length === 0 ? (
                <>
                    <p className="ma-gate-body">{copy.noMachine}</p>
                    <Button variant="secondary" onClick={() => navigate('/machine/connect')}>{copy.connectMachine}</Button>
                </>
            ) : (
                <>
                    <div className="ma-machine-list" role="radiogroup" aria-label={copy.enableMachine}>
                        {candidates.map((m) => (
                            <button key={m.id} type="button" role="radio" aria-checked={chosen === m.id} className="ma-machine-row" onClick={() => setPicked(m.id)}>
                                <span className="ma-machine-radio" aria-hidden />
                                <span className="ma-machine-name">{machineLabel(m)}</span>
                                <span className="ma-machine-meta mono">{m.metadata?.platform ?? ''}</span>
                                {recommended?.id === m.id && <span className="ma-machine-badge">{copy.recommended}</span>}
                            </button>
                        ))}
                    </div>
                    {actions.spawnError && <SpawnError error={actions.spawnError} copy={copy} />}
                    <Button variant="primary" loading={actions.spawning} disabled={!chosen} onClick={() => chosen && void actions.enable(chosen)}>
                        {copy.enable}
                    </Button>
                </>
            )}
        </div>
    );
}

function MainAgentConversation({ sessionId, gates, offlineMachine, copy }: { sessionId: string; gates: boolean; offlineMachine: string | null; copy: MainAgentCopy }) {
    const navigate = useNavigate();
    const ime = useImeGuard();
    useEffect(() => { sync.onSessionEnter(sessionId); }, [sessionId]);
    const session = useSession(sessionId);
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const transcript = useMemo(() => deriveTranscript(messages, { keepOptions: true }), [messages]);
    const pending = useMemo(() => derivePendingPermission(session?.agentState), [session?.agentState]);

    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const logRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [transcript.length, session?.thinking]);
    // keep the latest turn in view when the log shrinks (soft keyboard, drawer resize) — if it was at the bottom
    useEffect(() => {
        const el = logRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        let atBottom = true;
        const onScroll = () => { atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
        const ro = new ResizeObserver(() => { if (atBottom) el.scrollTop = el.scrollHeight; });
        el.addEventListener('scroll', onScroll, { passive: true });
        ro.observe(el);
        return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll); };
    }, []);

    const send = useCallback((text: string) => {
        const v = text.trim();
        if (!v) return;
        void sync.sendMessage(sessionId, v);
    }, [sessionId]);

    // ⌘K hand-over: a pending draft is sent (send: true) or put in the composer
    useEffect(() => {
        const d = useMainAgentStore.getState().takePendingDraft();
        if (!d) return;
        if (d.send) send(d.text);
        else setDraft(d.text);
        inputRef.current?.focus();
    }, [send]);

    const submit = () => {
        if (!draft.trim()) return;
        send(draft);
        setDraft('');
    };

    return (
        <>
            {offlineMachine && <div className="ma-banner" role="status">{copy.offlineBanner(offlineMachine)}</div>}
            {!gates && <div className="ma-banner" role="status" data-gates="missing">{copy.gatesMissing}</div>}
            {pending && (
                <div className="ma-banner ma-banner--warn" role="status">
                    <span>{copy.permissionBanner}</span>
                    <button type="button" className="ma-link-btn" onClick={() => navigate(`/session/${sessionId}`)}>{copy.permissionOpen}</button>
                </div>
            )}
            <div className="ma-log" role="log" aria-live="polite" ref={logRef}>
                {!isLoaded && <div className="ma-center"><Spinner size={18} /></div>}
                {isLoaded && transcript.length === 0 && <p className="ma-empty">{copy.empty}</p>}
                {transcript.map((e) => {
                    if (e.role === 'thinking') return null;
                    if (e.role === 'tool') {
                        return e.detail ? (
                            <details key={e.id} className="ma-tool">
                                <Summary className="ma-tool-summary"><span className="mono">{e.toolName}</span>{e.toolState && e.toolState !== 'completed' && <span className="ma-tool-state">· {e.toolState}</span>}</Summary>
                                <pre className="ma-tool-body mono">{e.detail}</pre>
                            </details>
                        ) : (
                            <div key={e.id} className="ma-tool"><span className="mono">{e.toolName}</span></div>
                        );
                    }
                    if (e.role === 'user') return <div key={e.id} className="ma-msg" data-role="user">{e.text}</div>;
                    return <div key={e.id} className="ma-msg" data-role="assistant"><Markdown text={e.text} onOption={send} /></div>;
                })}
                {session?.thinking && <div className="ma-thinking" aria-label={copy.statusThinking}><Spinner size={14} /> {copy.statusThinking}</div>}
            </div>
            <form className="ma-composer" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
                <textarea
                    ref={inputRef}
                    className="ma-input"
                    rows={1}
                    value={draft}
                    placeholder={copy.placeholder}
                    aria-label={copy.placeholder}
                    onChange={(ev) => setDraft(ev.target.value)}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(ev) => {
                        if (ev.key !== 'Enter' || ev.shiftKey || ime.isGuarded(ev.nativeEvent)) return;
                        // touch keyboards: Enter is a newline, the send button sends
                        if (window.matchMedia?.('(pointer: coarse)').matches) return;
                        ev.preventDefault();
                        submit();
                    }}
                />
                <button type="submit" className="ma-send-btn" disabled={!draft.trim()} aria-label={copy.send} title={copy.send}><SendHorizontal size={18} /></button>
            </form>
        </>
    );
}
