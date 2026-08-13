/**
 * AssistantScreen — the /assistant full-screen voice form (B-051).
 *
 * The meta-agent is a machine-side claude session tagged
 * `metadata.variant === 'assistant'`; this screen is only its voice VIEW:
 * find-or-spawn the session, push-to-talk → STT → sendMessage, subscribe the
 * reply stream, and read new replies aloud through the TTS queue.
 *
 * Full-screen on purpose: routed as a SIBLING of AppLayout (no sidebar).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mic, Volume2, RotateCcw, SendHorizontal, Settings, Server, ShieldAlert, ScrollText } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';
import { storage, useAllMachines, useAllSessions, useSession, useSessionMessages, useSetting, useSettingMutable } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { machineSpawnNewSession, sessionArchive } from '@/sync/ops';
import { transcribeAudio, synthesizeSpeech } from '@/sync/apiVoice';
import { machineLabel } from '@/utils/machineUtils';
import { ASSISTANT_DIRECTORY, ASSISTANT_MIN_CLI_VERSION, TTS_MAX_CHARS } from '@/assistant/assistantConstants';
import { isAssistantSupported } from '@/assistant/assistantSupport';
import { pickAssistantMachine, pickAssistantSession } from '@/assistant/assistantSession';
import { deriveAssistantExchange, collectNewAgentTexts, collectMessageIds, derivePendingPermission, deriveTranscript, extractOptions } from '@/assistant/assistantView';
import { truncateAtSentenceBoundary } from '@/assistant/sentenceTruncate';
import { useHoldToTalk } from '@/assistant/useHoldToTalk';
import { TtsPlayer } from '@/assistant/ttsPlayer';
import { unlockAudioPlayback, releaseAudioKeepAlive } from '@/assistant/iosAudioUnlock';
import { useAssistantStore, deriveVoiceState } from '@/assistant/assistantStore';
import { AssistantLogo, type AssistantLogoState } from './AssistantLogo';
import { CyberMark } from '@/ui';
import './assistant.css';

export function AssistantScreen() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const toast = useToast();
    const { credentials } = useAuth();
    const ime = useImeGuard();

    const rootRef = useRef<HTMLDivElement | null>(null);
    useKeyboardViewportPin(rootRef);

    // ── store ──
    const sessionId = useAssistantStore((s) => s.sessionId);
    const speaking = useAssistantStore((s) => s.speaking);
    const audioUnlocked = useAssistantStore((s) => s.audioUnlocked);
    const ttsAvailability = useAssistantStore((s) => s.ttsAvailability);
    const lastTtsTruncated = useAssistantStore((s) => s.lastTtsTruncated);

    // ── machine resolution ──
    const machines = useAllMachines({ includeOffline: true });
    const [assistantMachineId, setAssistantMachineId] = useSettingMutable('assistantMachineId');
    const machinePick = useMemo(
        () => pickAssistantMachine(machines, assistantMachineId),
        [machines, assistantMachineId],
    );
    const machine = machinePick.kind === 'machine' ? machinePick.machine : null;
    const cliVersion = machine?.metadata?.happyCliVersion ?? null;
    const supported = machine ? isAssistantSupported(cliVersion) : false;

    // ── session resolution (find, else spawn once data is ready) ──
    const dataReady = storage((s) => s.isDataReady);
    const sessions = useAllSessions();
    const found = useMemo(
        () => (machine ? pickAssistantSession(sessions, machine.id) : null),
        [sessions, machine],
    );
    const spawningRef = useRef(false);
    const [spawnError, setSpawnError] = useState<string | null>(null);

    // "Skip permission approvals" (Settings → Voice; default true = current
    // yolo behavior). Read through a ref so toggling the setting doesn't
    // invalidate spawnAssistant (and with it the find-or-spawn effect).
    const assistantSkipPermissions = useSetting('assistantSkipPermissions');
    const skipPermissionsRef = useRef(assistantSkipPermissions);
    skipPermissionsRef.current = assistantSkipPermissions;

    const spawnAssistant = useCallback(
        async (machineId: string, opts?: { forceNew?: boolean }) => {
            if (spawningRef.current) return;
            spawningRef.current = true;
            setSpawnError(null);
            try {
                const res = await machineSpawnNewSession({
                    machineId,
                    directory: ASSISTANT_DIRECTORY, // compat placeholder; new daemons pick their own cwd
                    approvedNewDirectoryCreation: true,
                    agent: 'claude',
                    variant: 'assistant',
                    // "new conversation": daemon stops the old assistant process
                    // and spawns fresh (old daemons ignore the field)
                    ...(opts?.forceNew ? { forceNew: true } : {}),
                    // Setting OFF → ask for approvals: spawn with the explicit
                    // 'default' mode. Setting ON (the default) sends nothing, so
                    // behavior is exactly as before (fork-wide yolo default).
                    ...(skipPermissionsRef.current ? {} : { permissionMode: 'default' }),
                });
                if (res.type === 'success') {
                    useAssistantStore.getState().setSessionId(res.sessionId);
                } else if (res.type === 'error') {
                    setSpawnError(res.errorMessage);
                } else {
                    // requestToApproveDirectoryCreation shouldn't happen (approved above)
                    setSpawnError(t('assistant.spawnError'));
                }
            } finally {
                spawningRef.current = false;
            }
        },
        [t],
    );

    useEffect(() => {
        if (!machine || !supported || !dataReady) return;
        if (found) {
            if (found.id !== sessionId) useAssistantStore.getState().setSessionId(found.id);
            return;
        }
        // After a failed spawn, do NOT auto-retry on unrelated re-renders
        // (machine heartbeats update its object identity) — the gate shows an
        // explicit retry button instead.
        if (!sessionId && !spawnError) void spawnAssistant(machine.id);
    }, [machine, supported, dataReady, found, sessionId, spawnError, spawnAssistant]);

    // lazy message fetch — same mechanism as the chat screen
    useEffect(() => {
        if (sessionId) sync.onSessionVisible(sessionId);
    }, [sessionId]);

    // ── conversation data ──
    const session = useSession(sessionId ?? '');
    const thinking = !!session?.thinking;
    const { messages, isLoaded } = useSessionMessages(sessionId ?? '');
    const exchange = useMemo(() => deriveAssistantExchange(messages), [messages]);
    const replyView = useMemo(
        () => (exchange.assistantText ? extractOptions(exchange.assistantText) : { text: null as string | null, options: [] as string[] }),
        [exchange.assistantText],
    );

    // Pending permission request (only exists when "skip permission approvals"
    // is off): surface a banner that links to the session page's approve UI.
    const pendingPermission = useMemo(
        () => derivePendingPermission(session?.agentState),
        [session?.agentState],
    );

    // ── B-059: TTS caption + in-place transcript panel ──
    const speakingText = useAssistantStore((s) => s.speakingText);
    const [showTranscript, setShowTranscript] = useState(false);
    const transcript = useMemo(
        () => (showTranscript ? deriveTranscript(messages) : []),
        [showTranscript, messages],
    );
    // keep the latest text in view — long replies stream past the fold
    const convoRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = convoRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [replyView.text, speakingText]);
    const transcriptRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = transcriptRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [showTranscript, transcript.length]);

    // ── settings ──
    const voiceTtsVoiceId = useSetting('voiceTtsVoiceId');
    const voiceReadTextReplies = useSetting('voiceReadTextReplies');

    // ── TTS player (created ONCE per visit; queue semantics in ttsQueue.ts) ──
    // credentials/voice/toast/t reach the callbacks through refs (optionsRef
    // precedent in useHoldToTalk): recreating the player on any of their
    // identity changes would dispose it MID-PLAYBACK — a toast popping (or
    // auto-expiring) must never cut off the reply being spoken.
    const playerRef = useRef<TtsPlayer | null>(null);
    const playerEnvRef = useRef({ credentials, voiceTtsVoiceId, toast, t });
    playerEnvRef.current = { credentials, voiceTtsVoiceId, toast, t };
    useEffect(() => {
        const player = new TtsPlayer({
            synthesize: (text) => {
                const { credentials: creds, voiceTtsVoiceId: voiceId } = playerEnvRef.current;
                if (!creds) return Promise.resolve({ kind: 'error' as const });
                return synthesizeSpeech(creds, text, { voiceId: voiceId ?? undefined });
            },
            onSpeakingChange: (v) => useAssistantStore.getState().setSpeaking(v),
            onUtteranceChange: (text) => useAssistantStore.getState().setSpeakingText(text),
            onUnsupported: () => {
                const st = useAssistantStore.getState();
                st.setTtsAvailability('unsupported');
                if (!st.ttsNoticeShown) {
                    st.markTtsNoticeShown();
                    const env = playerEnvRef.current;
                    env.toast.show(env.t('assistant.ttsUnavailable'), 'info');
                }
            },
        });
        playerRef.current = player;
        return () => {
            player.dispose();
            if (playerRef.current === player) playerRef.current = null;
        };
    }, []);

    // ── read NEW replies aloud (baseline = ids present on attach/reset) ──
    const baselineRef = useRef<Set<string> | null>(null);
    useEffect(() => {
        baselineRef.current = null;
    }, [sessionId]);
    useEffect(() => {
        if (!isLoaded) return;
        if (baselineRef.current === null) {
            baselineRef.current = collectMessageIds(messages);
            return;
        }
        const fresh = collectNewAgentTexts(messages, baselineRef.current);
        if (fresh.length === 0) return;
        for (const m of fresh) baselineRef.current.add(m.id);
        const st = useAssistantStore.getState();
        const shouldSpeak =
            st.audioUnlocked &&
            st.ttsAvailability !== 'unsupported' &&
            (st.lastTurnSource === 'voice' || voiceReadTextReplies);
        if (!shouldSpeak) return;
        for (const m of fresh) {
            // never speak the <options> block — it is rendered as buttons
            const spoken = extractOptions(m.text).text;
            if (!spoken) continue;
            const { text, truncated } = truncateAtSentenceBoundary(spoken, TTS_MAX_CHARS);
            if (truncated) st.setLastTtsTruncated(true);
            playerRef.current?.enqueue({ id: m.id, text });
        }
    }, [messages, isLoaded, voiceReadTextReplies]);

    // ── sending ──
    const sendText = useCallback(
        (text: string, source: 'voice' | 'text') => {
            const id = useAssistantStore.getState().sessionId;
            if (!id || !text.trim()) return;
            const st = useAssistantStore.getState();
            st.setLastTurnSource(source);
            st.setLastTtsTruncated(false);
            void sync.sendMessage(id, text.trim());
        },
        [],
    );

    // ── push-to-talk ──
    const holdToTalk = useHoldToTalk({
        transcribe: async (b64, mime) => {
            if (!credentials) return '';
            return transcribeAudio(credentials, b64, mime);
        },
        onText: (text) => sendText(text, 'voice'),
        onLevel: (level) => {
            rootRef.current?.style.setProperty('--as-level', level.toFixed(3));
        },
        onMicError: () => toast.error(t('assistant.micError')),
        disabled: !sessionId,
    });
    useEffect(() => {
        useAssistantStore.getState().setRecorderState(holdToTalk.state);
    }, [holdToTalk.state]);

    // barge-in: pressing PTT stops the current reply playback
    const onPttPointerDown = useCallback(
        (e: React.PointerEvent<HTMLButtonElement>) => {
            playerRef.current?.stop();
            holdToTalk.handlers.onPointerDown(e);
        },
        [holdToTalk.handlers],
    );

    // ── audio unlock (per page visit; released on leave) ──
    const onUnlock = useCallback(async () => {
        const ok = await unlockAudioPlayback();
        if (!ok) {
            // context refused to run — do NOT mark unlocked: keep the button
            // visible so the user can retry with a fresh gesture. STT still works.
            console.warn('[assistant] audio unlock failed — context not running');
            const env = playerEnvRef.current;
            env.toast.error(env.t('assistant.audioUnlockFailed'));
            return;
        }
        useAssistantStore.getState().setAudioUnlocked(true);
    }, []);
    useEffect(() => {
        // fresh probe per visit: an 'unsupported' verdict from a previous visit
        // (old server / unconfigured) must not outlive the screen — W3
        useAssistantStore.getState().resetTtsGate();
        return () => {
            releaseAudioKeepAlive();
            const st = useAssistantStore.getState();
            st.setAudioUnlocked(false);
            st.setSpeaking(false);
            st.setRecorderState('idle');
        };
    }, []);

    // ── new conversation: forceNew respawn, then archive the old session ──
    const [resetting, setResetting] = useState(false);
    const onNewConversation = useCallback(async () => {
        if (!machine || resetting) return;
        setResetting(true);
        try {
            playerRef.current?.stop();
            const st = useAssistantStore.getState();
            const previous = st.sessionId;
            st.resetConversation();
            st.setSessionId(null);
            baselineRef.current = null;
            // forceNew: the daemon stops the old assistant process and spawns
            // fresh, so we don't depend on archive-before-spawn ordering (an
            // old daemon would just return the existing session — same as before).
            await spawnAssistant(machine.id, { forceNew: true });
            // archive the replaced session AFTER the new one exists (list
            // hygiene); skip if spawn failed or the daemon reused the same id.
            const fresh = useAssistantStore.getState().sessionId;
            if (previous && fresh && previous !== fresh) {
                await sessionArchive(previous);
            }
        } finally {
            setResetting(false);
        }
    }, [machine, resetting, spawnAssistant]);

    // ── text input ──
    const [draft, setDraft] = useState('');
    const onSubmitDraft = useCallback(() => {
        if (!draft.trim()) return;
        sendText(draft, 'text');
        setDraft('');
    }, [draft, sendText]);

    // ── logo state ──
    const voiceState = deriveVoiceState(holdToTalk.state, speaking, thinking);
    const logoState: AssistantLogoState =
        voiceState === 'recording'
            ? 'listening'
            : voiceState === 'transcribing' || voiceState === 'waiting'
              ? 'thinking'
              : voiceState === 'speaking'
                ? 'speaking'
                : 'idle';
    const stateLabel =
        voiceState === 'recording'
            ? t('assistant.stateListening')
            : voiceState === 'transcribing'
              ? t('assistant.stateTranscribing')
              : voiceState === 'waiting'
                ? t('assistant.stateThinking')
                : voiceState === 'speaking'
                  ? t('assistant.stateSpeaking')
                  : t('assistant.stateIdle');

    // ── gates ──
    let gate: React.ReactNode = null;
    if (machinePick.kind === 'none') {
        gate = (
            <div className="as-gate">
                <div className="as-gate-title">{t('assistant.noMachineTitle')}</div>
                <div className="as-gate-desc">{t('assistant.noMachineDesc')}</div>
            </div>
        );
    } else if (machinePick.kind === 'choose') {
        gate = (
            <div className="as-gate">
                <div className="as-gate-title">{t('assistant.chooseMachine')}</div>
                {machinePick.online.map((m) => (
                    <button
                        key={m.id}
                        type="button"
                        className="as-machine-btn"
                        onClick={() => setAssistantMachineId(m.id)}
                    >
                        <Server size={15} />
                        {machineLabel(m)}
                    </button>
                ))}
            </div>
        );
    } else if (!supported) {
        gate = (
            <div className="as-gate">
                <div className="as-gate-title">{t('assistant.upgradeCliTitle')}</div>
                <div className="as-gate-desc">
                    {t('assistant.upgradeCliDesc', {
                        version: ASSISTANT_MIN_CLI_VERSION,
                        current: cliVersion ?? '?',
                    })}
                </div>
                <code className="as-gate-code">npm i -g very-happy-cli@latest</code>
            </div>
        );
    } else if (spawnError) {
        gate = (
            <div className="as-gate">
                <div className="as-gate-title">{t('assistant.spawnError')}</div>
                <div className="as-gate-desc">{spawnError}</div>
                <button type="button" className="as-machine-btn" onClick={() => machine && void spawnAssistant(machine.id)}>
                    <RotateCcw size={15} />
                    {t('assistant.retry')}
                </button>
            </div>
        );
    }

    return (
        <div className="as-root" ref={rootRef}>
            <div className="as-col">
                <header className="as-header">
                    {/* same slot as the sidebar's form-switch button — switches back */}
                    <button
                        type="button"
                        className="as-icon-btn"
                        aria-label={t('assistant.back')}
                        title={t('assistant.back')}
                        onClick={() => navigate('/')}
                    >
                        <ArrowLeft size={18} />
                    </button>
                    <span className="as-header-title">{t('assistant.title')}</span>
                    {machine && <span className="as-header-machine">{machineLabel(machine)}</span>}
                    <span className="as-header-spacer" />
                    <button
                        type="button"
                        className="as-icon-btn"
                        data-active={showTranscript}
                        aria-label={t('assistant.transcript')}
                        title={t('assistant.transcript')}
                        onClick={() => setShowTranscript((v) => !v)}
                    >
                        <ScrollText size={17} />
                    </button>
                    <button
                        type="button"
                        className="as-icon-btn"
                        aria-label={t('settingsVoice.title')}
                        title={t('settingsVoice.title')}
                        onClick={() => navigate('/settings/voice')}
                    >
                        <Settings size={17} />
                    </button>
                </header>

                {showTranscript && (
                    <div className="as-transcript" role="log" ref={transcriptRef}>
                        {transcript.length === 0 && (
                            <div className="as-transcript-empty">{t('assistant.transcriptEmpty')}</div>
                        )}
                        {transcript.map((e) => {
                            if (e.role === 'thinking') {
                                return (
                                    <details key={e.id} className="as-transcript-fold" data-role="thinking">
                                        <summary>{t('assistant.thinkingTrace')}</summary>
                                        <div className="as-transcript-fold-body">{e.detail}</div>
                                    </details>
                                );
                            }
                            if (e.role === 'tool') {
                                return e.detail ? (
                                    <details key={e.id} className="as-transcript-fold" data-role="tool">
                                        <summary className="as-transcript-tool">{e.text}</summary>
                                        <div className="as-transcript-fold-body as-transcript-tool">{e.detail}</div>
                                    </details>
                                ) : (
                                    <div key={e.id} className="as-transcript-entry" data-role="tool">
                                        <span className="as-transcript-tool">{e.text}</span>
                                    </div>
                                );
                            }
                            return (
                                <div key={e.id} className="as-transcript-entry" data-role={e.role}>
                                    {e.text}
                                </div>
                            );
                        })}
                    </div>
                )}

                {gate ?? (
                    <>
                        <div className="as-stage">
                            <AssistantLogo state={logoState} glyph={<CyberMark size={44} />} />
                            <div
                                className="as-state-label"
                                data-live={logoState === 'listening' || logoState === 'speaking'}
                            >
                                {sessionId ? stateLabel : t('assistant.connecting')}
                            </div>

                            {pendingPermission && sessionId && (
                                <button
                                    type="button"
                                    className="as-perm-banner"
                                    onClick={() => navigate(`/session/${sessionId}`)}
                                >
                                    <ShieldAlert size={14} />
                                    <span className="as-perm-banner-text">
                                        {t('assistant.permissionWaiting', { tool: pendingPermission.tool })}
                                    </span>
                                    <span className="as-perm-banner-go">{t('assistant.permissionGo')}</span>
                                </button>
                            )}

                            <div className="as-convo" ref={convoRef}>
                                {exchange.userText && <div className="as-convo-user">{exchange.userText}</div>}
                                {/* B-059: while speaking, the spoken sentence is the caption */}
                                {speakingText ? (
                                    <div className="as-caption">{speakingText}</div>
                                ) : (
                                    replyView.text && (
                                        <div className="as-convo-assistant">{replyView.text}</div>
                                    )
                                )}
                                {/* assistant's multiple-choice → tappable answers (only while
                                    its question is still the latest word) */}
                                {!speakingText && exchange.latestRole === 'assistant' && replyView.options.length > 0 && (
                                    <div className="as-options">
                                        {replyView.options.map((o) => (
                                            <button
                                                key={o}
                                                type="button"
                                                className="as-option-btn"
                                                onClick={() => sendText(o, 'text')}
                                            >
                                                {o}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {lastTtsTruncated && (
                                    <div className="as-convo-note">{t('assistant.ttsTruncated')}</div>
                                )}
                            </div>
                            <div className="as-ticker" data-running={exchange.tool?.state === 'running'}>
                                {exchange.tool && (thinking || exchange.tool.state === 'running') && (
                                    <span>
                                        {exchange.tool.state === 'running' ? '▸' : '·'} {exchange.tool.name}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="as-controls">
                            {!audioUnlocked && ttsAvailability !== 'unsupported' && (
                                <button
                                    type="button"
                                    className="as-unlock-btn"
                                    title={t('assistant.enableVoiceHint')}
                                    onClick={() => void onUnlock()}
                                >
                                    <Volume2 size={15} />
                                    {t('assistant.enableVoice')}
                                </button>
                            )}

                            <button
                                type="button"
                                className="as-ptt"
                                data-recording={holdToTalk.state === 'recording'}
                                disabled={!sessionId || holdToTalk.state === 'transcribing'}
                                aria-label={t('assistant.holdToTalk')}
                                onPointerDown={onPttPointerDown}
                                onPointerUp={holdToTalk.handlers.onPointerUp}
                                onPointerCancel={holdToTalk.handlers.onPointerCancel}
                                onContextMenu={holdToTalk.handlers.onContextMenu}
                            >
                                <Mic size={30} />
                            </button>
                            <span className="as-ptt-hint">{t('assistant.holdToTalk')}</span>

                            <div className="as-input-row">
                                <input
                                    className="as-input"
                                    type="text"
                                    value={draft}
                                    placeholder={t('assistant.textPlaceholder')}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onCompositionStart={ime.onCompositionStart}
                                    onCompositionEnd={ime.onCompositionEnd}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !ime.isGuarded(e)) {
                                            e.preventDefault();
                                            onSubmitDraft();
                                        }
                                    }}
                                />
                                <button
                                    type="button"
                                    className="as-send-btn"
                                    aria-label={t('assistant.send')}
                                    disabled={!draft.trim() || !sessionId}
                                    onClick={onSubmitDraft}
                                >
                                    <SendHorizontal size={16} />
                                </button>
                                <button
                                    type="button"
                                    className="as-reset-btn"
                                    disabled={!machine || resetting}
                                    onClick={() => void onNewConversation()}
                                >
                                    <RotateCcw size={14} />
                                    {t('assistant.newConversation')}
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
