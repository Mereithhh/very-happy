import { selectDisplayedEffortKey } from './effortSelection';
import { supportsSessionAttachments } from '@/sync/attachmentCapabilities';
import { ModelEffortMenu } from './ModelEffortMenu';
import { onMessageQuote } from './messageQuote';
import { mergeRestoredDraft, onComposerRestore } from './composerRestore';
import { appendMessageQuote } from './messageActionsModel';
/**
 * AgentInput — the composer. A rounded auto-growing textarea + circular send
 * button, with permissions and model in one row; context sits below.
 *
 * Sending: see utils/composerEnter (desktop Enter sends, Cmd/Ctrl/Shift+Enter
 * newline; soft keyboards newline). IME-safe: never sends mid-composition.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CornerDownRight, Pencil, ArrowUp, Square, Trash2, X, Shield, Gauge, MoreHorizontal, ListEnd } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { randomUUID } from 'expo-crypto';
import { sync } from '@/sync/sync';
import { sessionAbort, sessionSetPermissionMode } from '@/sync/ops';
import {
    useSession,
    useSessionUsage,
    useSetting,
    storage,
} from '@/sync/storage';
import { registerDraftFlush } from '@/app/draftFlush';
import { useTranslation } from '@/i18n/useTranslation';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    compactResolvedModelCode,
    relabelDefaultModel,
} from '@/components/modelModeOptions';
import { isImeGuardedEvent, useImeGuard } from '@/utils/ime';
import { insertComposerNewline, isSoftKeyboardDevice, resolveComposerEnter } from '@/utils/composerEnter';
import { onInsertToInput } from '@/app/insertToInput';
import {
    isPiAgent,
    normalizeAgentKey,
    resolveAgentDefaultConfig,
    resolveDefaultModelMode,
    setAgentDefaultOverride,
    type AgentDefaultField,
} from '@/sync/agentDefaults';
import { ModeMenu } from './ModeMenu';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { deriveRunningModelSubtitle, selectDisplayedModelKey } from './modelDisplay';
import { loadQueuedMessages, saveQueuedMessages } from '@/sync/persistence';
import {
    advanceQueueDeliveryPhase,
    deliverQueuedMessage,
    QUEUE_START_TIMEOUT_MS,
    canReleaseQueuedMessage,
    parsePersistedQueuedMessages,
    persistableQueuedMessages,
    removeQueuedMessage,
    updateQueuedMessage,
    type QueuedMessage,
    type QueueDeliveryPhase,
} from './queuedMessages';
import { composerGate, restoreSession, useRestoreState } from '@/app/sessionRestore';
import {
    enqueuePrompt,
    loadPromptQueue,
    movePrompt,
    removePrompt,
    supportsServerPromptQueue,
    updatePromptText,
    usePromptQueue,
} from '@/sync/promptQueue';

/** B-509: idle + server-queued items for this long = the wrapper is not popping. */
export const PROMPT_QUEUE_STALE_MS = 30_000;

// Sentinel key for the「默认」effort entry — not a real SDK effort level
// (the CLI validates against low/medium/high/xhigh/max, so this can never
// collide); picking it clears effortLevel and the wire carries effort:null.
const EFFORT_DEFAULT_KEY = 'default';
import { PresetsMenu } from './PresetsMenu';
import {
    useAttachments,
    getFilesFromClipboard,
    getFilesFromDrop,
    SUPPORTED_IMAGE_MIME_TYPES,
} from './useAttachments';
import { Modal } from '@/modal';
import { Spinner, useToast } from '@/ui';
import { abortOutcomeForError, type AbortOutcome } from './abortOutcome';
import { contextPercentOf, composerContextUsage } from './contextWindow';
import { formatTokens } from './format';
import { getAllCommands } from '@/sync/suggestionCommands';
import { filterSlashSuggestions, slashCommandText } from './slashSuggestions';
import { BTW_COMMAND, canOfferBtw, parseBtwCommand } from './btwCommand';
import { openBtwPanel } from './btwPanelState';
import {
    COMPOSER_MOBILE_MIN_HEIGHT,
    composerHeightCap,
    composerTextareaHeight,
} from './composerExpand';
import './input.css';
import { ComposerAttachments } from './ComposerAttachments';
import { shouldApplyPermissionModeLive } from './livePermissionMode';
import { derivePermissionModeDisplay } from './permissionModeDisplay';
import { resolveIntentSource } from '@/sync/yoloEnforcement';
import { getAgentDefaultOverride } from '@/sync/agentDefaults';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';
import { yieldForSendFeedback } from './sendFeedback';

// Touch-first device — gates the conditional refocus below; desktop keeps the
// historical unconditional refocus (mouse-clicking Send should return the
// caret to the textarea).
const IS_COARSE_POINTER =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

function persistSessionQueue(sessionId: string, queue: QueuedMessage[]) {
    const all = loadQueuedMessages();
    const persisted = persistableQueuedMessages(queue);
    if (persisted.length > 0) all[sessionId] = persisted;
    else delete all[sessionId];
    saveQueuedMessages(all);
}

/**
 * B-516: the composer on an optimistic pending page. There is no session yet,
 * so sends go to the pending record's outbox and mode choices to the record
 * (the pending store writes them to the real session before anything is sent).
 */
export interface PendingComposer {
    /** Append to the outbox. False = not accepted; the text stays in the composer. */
    onSend: (text: string) => boolean;
    /** Why a send is not accepted right now (failed start, owned by another tab). */
    blockedHint?: string;
    permissionMode: string | null;
    modelMode?: string | null;
    effortLevel?: string | null;
    onMode: (field: AgentDefaultField, value: string | null) => void;
    /** A pending id has no session to carry `draft`. */
    initialDraft: string;
    /** The record was discarded: the unmount flush must not re-create its draft. */
    isGone?: () => boolean;
}

export function AgentInput({ sessionId, agentFlavor, pending }: {
    sessionId: string;
    /** Used while `session` is null (pending page): options and default overrides
     *  must follow the chosen agent, not fall back to Claude's slot. */
    agentFlavor?: string;
    pending?: PendingComposer;
}) {
    const { t } = useTranslation();
    const toast = useToast();
    const session = useSession(sessionId);
    const usage = useSessionUsage(sessionId);
    const enterToSend = useSetting('agentInputEnterToSend');
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');

    const taRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const ime = useImeGuard();
    const [text, setText] = useState(session?.draft ?? pending?.initialDraft ?? '');
    const draftRef = useRef(text);
    draftRef.current = text;
    const [sending, setSending] = useState(false);
    // React state can batch Enter/click events; take the send slot synchronously.
    const sendingRef = useRef(false);
    const [aborting, setAborting] = useState(false);
    const [interveningId, setInterveningId] = useState<string | null>(null);
    const [queued, setQueued] = useState<QueuedMessage[]>(() =>
        parsePersistedQueuedMessages(loadQueuedMessages()[sessionId]),
    );
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState('');
    const [slashIndex, setSlashIndex] = useState(0);
    const [dismissedSlashText, setDismissedSlashText] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [permissionModeBusy, setPermissionModeBusy] = useState(false);
    // B-098 手动展开态：上限 200px ↔ ~60% 视口高。会话内状态，刻意不持久化。
    const [expanded, setExpanded] = useState(false);
    const { attachments, processing: processingAttachments, addFiles, remove, take, restore } = useAttachments();
    const queuedRef = useRef(queued);
    queuedRef.current = queued;
    const deliveryPhaseRef = useRef<QueueDeliveryPhase>('idle');
    /** B-322: when we entered `waiting-start`, so it can time out (queuedMessages.ts). */
    const waitingStartSinceRef = useRef<number | null>(null);
    const [stuckTick, setStuckTick] = useState(0);

    useEffect(() => () => {
        for (const item of queuedRef.current) {
            for (const attachment of item.attachments ?? []) {
                if (attachment.uri?.startsWith('blob:')) URL.revokeObjectURL(attachment.uri);
            }
        }
    }, []);

    const supportsAttachments = supportsSessionAttachments(session?.metadata);

    const flavor = (session?.metadata?.flavor ?? agentFlavor) as any;
    const metadata = session?.metadata ?? null;
    const attachmentKinds = metadata?.attachmentKinds ?? [];
    const supportsAnyAttachments = attachmentKinds.includes('*/*');
    const supportsPdfAttachments = attachmentKinds.includes('application/pdf');
    // B-322: the fourth site B-295 missed. `runningTool` is last-known
    // transcript state — a tool call whose wrapper was killed never closes, and
    // it used to pin `isWorking` true forever, which held every new message in
    // the tab-local queue and kept the Stop button up over a session that had
    // nothing to stop. Liveness has exactly one entry point (铁律 13), lease
    // included.
    const leaseFresh = useHeartbeatFresh(sessionId);
    const isWorking = isAgentWorkLive({
        presence: session?.presence,
        thinking: session?.thinking,
        runningSubagentsInTurn: 0,
        heartbeatFresh: leaseFresh,
    });
    // B-265: an archived session's composer restores first and queues; the
    // queue releases once the session is back (archivedAt cleared + online).
    const gate = composerGate(session);
    const restoreState = useRestoreState(sessionId);
    // B-509: prompts queued while the agent works live on the SERVER when the
    // wrapper advertises `prompt-queue-v1` and the server has the route; the
    // wrapper pops them one per turn, so closing every tab changes nothing.
    // Otherwise (old wrapper / old server / attachments) the tab-local queue
    // below keeps working exactly as before.
    const serverQueueState = usePromptQueue(sessionId);
    const serverQueue = supportsServerPromptQueue(metadata) && serverQueueState.status !== 'unsupported';
    useEffect(() => {
        if (serverQueue) void loadPromptQueue(sessionId);
    }, [serverQueue, sessionId]);
    const hasPendingPermission = Object.keys(session?.agentState?.requests ?? {}).length > 0;
    // B-283: `/btw` is a WEB command (never sent to the CLI) — list it first on
    // any Claude session; the panel itself explains when the wrapper is too old.
    const slashSuggestions = dismissedSlashText === text
        ? []
        : filterSlashSuggestions(
            canOfferBtw(session)
                ? [{ command: BTW_COMMAND, description: t('session.btw.commandDescription') }, ...getAllCommands(sessionId)]
                : getAllCommands(sessionId),
            text,
        );

    useEffect(() => {
        setSlashIndex(0);
    }, [text, sessionId]);

    useEffect(() => {
        persistSessionQueue(sessionId, queued);
    }, [queued, sessionId]);

    // selectors
    const agentDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, flavor);
    const modelKey = pending?.modelMode ?? session?.modelMode ?? resolveDefaultModelMode(agentDefaultOverrides, flavor, session ? (metadata ?? {}) : null);
    const resolvedDefaultModel = metadata?.defaultModelCode
        ?? (modelKey === 'default' ? usage?.model : undefined);
    const defaultModelLabel = resolvedDefaultModel
        ? t('session.chat.defaultModelResolved', { model: compactResolvedModelCode(resolvedDefaultModel) })
        : t('session.chat.defaultModelUnknown');
    const models = relabelDefaultModel(
        getAvailableModels(flavor, metadata, t as any),
        defaultModelLabel,
    );
    const permModes = getAvailablePermissionModes(flavor, metadata, t as any);
    const efforts = getEffortLevelsForModel(flavor, modelKey ?? 'default', metadata);
    const permKey = (pending ? pending.permissionMode : session?.permissionMode) ?? agentDefaults.permissionMode;
    const effortKey = (pending ? pending.effortLevel : session?.effortLevel) ?? agentDefaults.effortLevel;
    // claude-ish flavors (incl. no flavor) support the explicit「默认」effort
    const isClaudeFlavor = normalizeAgentKey(flavor) === 'claude';
    // pi (flavor 'acp') is its own agent key (B-370) but shares two Claude traits: the
    // CLI publishes the permission mode really in effect (metadata.permissionMode,
    // B-350) and the model really running (metadata.currentModelCode, B-362), so the
    // honesty subtitles below apply to both. Steer / live permission RPC / the
    // explicit 「default」 effort option stay Claude-only.
    const publishesModeFacts = isClaudeFlavor || isPiAgent(flavor);
    const supportsSteer = isClaudeFlavor
        && metadata?.capabilities?.includes('claude-steer-v1') === true
        && session?.agentState?.controlledByUser === false;
    const supportsLivePermissionMode = shouldApplyPermissionModeLive({
        isClaude: isClaudeFlavor,
        isWorking: isWorking || hasPendingPermission,
        isRemote: session?.agentState?.controlledByUser === false,
        isOnline: session?.presence === 'online',
        capabilities: metadata?.capabilities,
    });
    const effortOptions = efforts.length === 0 ? [] : isClaudeFlavor
        ? [{ key: EFFORT_DEFAULT_KEY, name: t('session.chat.effortDefault'), description: t('session.chat.effortDefaultDesc') }, ...efforts]
        : efforts;
    const effectiveModelCode = modelKey === 'default'
        ? metadata?.defaultModelCode ?? metadata?.currentModelCode
        : modelKey;
    const backendDefaultEffort = metadata?.models?.find((model) => model.code === effectiveModelCode)?.defaultReasoningEffort;
    const selectedEffortKey = isClaudeFlavor
        ? selectDisplayedEffortKey(effortOptions, [effortKey, metadata?.currentThoughtLevelCode, backendDefaultEffort, EFFORT_DEFAULT_KEY])
        : selectDisplayedEffortKey(efforts, [
            session?.effortLevel,
            getAgentDefaultOverride(agentDefaultOverrides, flavor).effortLevel,
            metadata?.currentThoughtLevelCode,
            isPiAgent(flavor) ? metadata?.currentOperatingModeCode : undefined,
            backendDefaultEffort,
        ]);
    // B-362: intent → running model (ACP runners publish it) → first option; never show
    // a model the session is not on just because the default key is not in the list.
    const displayedModelKey = selectDisplayedModelKey({
        selectedKey: modelKey,
        running: metadata?.currentModelCode,
        optionKeys: models.map((option) => option.key),
    });
    // B-262 A4: honest subtitle — what the CLI has confirmed vs. what we intend.
    const permissionDisplayState = publishesModeFacts
        ? derivePermissionModeDisplay({
            displayed: permKey,
            published: metadata?.permissionMode,
            dangerouslySkipPermissions: metadata?.dangerouslySkipPermissions,
            intentSource: resolveIntentSource({
                published: metadata?.permissionMode,
                local: session?.permissionMode,
                override: getAgentDefaultOverride(agentDefaultOverrides, flavor).permissionMode,
            }),
            busy: permissionModeBusy,
        })
        : 'confirmed';
    const permissionSubtitle = (() => {
        switch (permissionDisplayState) {
            case 'confirmed': return undefined;
            case 'pending': return t('session.chat.permissionModeState.pending');
            case 'conflict': return t('session.chat.permissionModeState.conflict', { mode: metadata?.permissionMode ?? '?' });
            case 'startup-yolo': return t('session.chat.permissionModeState.startupYolo');
            case 'unconfirmed-intent': return t('session.chat.permissionModeState.unconfirmedIntent');
            case 'unconfirmed-guess': return t('session.chat.permissionModeState.unconfirmedGuess');
            case 'unconfirmed-other': return t('session.chat.permissionModeState.unconfirmedOther');
        }
    })();
    // B-292: the selector value is client intent and flips on tap; this is the
    // only thing on screen that reports what the agent is actually running.
    const modelSubtitle = deriveRunningModelSubtitle({
        isClaude: publishesModeFacts,
        selectedKey: modelKey,
        running: metadata?.currentModelCode,
    });
    // context meter — always visible when we have a usage snapshot.
    const context = composerContextUsage(isPiAgent(flavor), session?.agentState?.contextUsage, usage, metadata?.currentModelCode);
    const contextKnown = context.tokens !== null;
    const contextSize = context.tokens ?? 0;
    const contextWindow = context.window;
    const percentUsed = contextKnown ? contextPercentOf(contextSize, contextWindow) : null;
    const contextTokens = contextKnown ? `${isPiAgent(flavor) ? '≈' : ''}${formatTokens(contextSize)}` : '—';
    const contextTotal = contextWindow === null ? null : formatTokens(contextWindow);
    const meterTone = percentUsed === null ? 'ok' : percentUsed >= 95 ? 'crit' : percentUsed >= 90 ? 'warn' : 'ok';
    const meterTitle = `${contextWindow === null ? contextSize.toLocaleString() : `${contextSize.toLocaleString()} / ${contextWindow.toLocaleString()}`} tokens`;

    // grow textarea — 收起时按内容自适应，展开时直接占满 ~60% 视口；不能只
    // 提高 max-height，否则空/短输入点击展开后没有任何视觉反馈（B-217）。
    const resizeTextarea = useCallback(() => {
        const ta = taRef.current;
        if (!ta) return;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const cap = composerHeightCap(expanded, viewportHeight);
        ta.style.maxHeight = `${cap}px`;
        ta.style.height = 'auto';
        ta.style.height = `${composerTextareaHeight(
            expanded,
            ta.scrollHeight,
            viewportHeight,
            IS_COARSE_POINTER ? COMPOSER_MOBILE_MIN_HEIGHT : 0,
        )}px`;
    }, [expanded]);

    useLayoutEffect(() => {
        resizeTextarea();
    }, [text, resizeTextarea]);

    // window.resize 覆盖桌面窗口；visualViewport.resize 覆盖移动端软键盘和
    // 浏览器 chrome 改变可用高度。两者可能同时触发，写同一确定值是幂等的。
    useEffect(() => {
        const viewport = window.visualViewport;
        window.addEventListener('resize', resizeTextarea);
        viewport?.addEventListener('resize', resizeTextarea);
        return () => {
            window.removeEventListener('resize', resizeTextarea);
            viewport?.removeEventListener('resize', resizeTextarea);
        };
    }, [resizeTextarea]);

    // 展开/收起切换：同一个 textarea，不做 modal；把焦点还给输入框（与
    // insertPreset 的 rAF refocus 手法一致），点按钮不丢焦点。
    const toggleExpanded = () => {
        setExpanded((v) => !v);
        requestAnimationFrame(() => taRef.current?.focus());
    };

    useEffect(() => onMessageQuote(sessionId, (quote) => {
        setText((current) => appendMessageQuote(current, quote));
        requestAnimationFrame(() => taRef.current?.focus());
    }), [sessionId]);

    // B-513: a failed message taken back from the transcript.
    useEffect(() => onComposerRestore(sessionId, (restored) => {
        const next = mergeRestoredDraft(restored, draftRef.current);
        draftRef.current = next;
        setText(next);
        requestAnimationFrame(() => taRef.current?.focus());
    }), [sessionId]);

    // persist draft (debounced via storage's own normalization)
    useEffect(() => {
        const id = setTimeout(() => {
            if (!pendingRef.current?.isGone?.()) storage.getState().updateSessionDraft(sessionId, text);
        }, 400);
        return () => clearTimeout(id);
    }, [text, sessionId]);

    // B-516: a discarded pending page must not get its draft written back by
    // the flushes below after discard() cleared its keys.
    const pendingRef = useRef(pending);
    pendingRef.current = pending;
    const flushDraft = () => {
        if (pendingRef.current?.isGone?.()) return;
        storage.getState().updateSessionDraft(sessionId, draftRef.current || null);
    };

    // Route switches remount the composer by session id. Flush the latest
    // value before unmount so a sub-debounce draft stays with its own session.
    useEffect(() => () => {
        flushDraft();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- flushDraft reads refs
    }, [sessionId]);

    // B-315: a background auto-update reloads the page without unmounting
    // anything, so the cleanup above never runs. Register the same flush for
    // the update path to call on its way out.
    useEffect(() => registerDraftFlush(() => {
        flushDraft();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- flushDraft reads refs
    }), [sessionId]);

    const releaseQueuedAttachments = (item: QueuedMessage) => {
        for (const attachment of item.attachments ?? []) {
            if (attachment.uri?.startsWith('blob:')) URL.revokeObjectURL(attachment.uri);
        }
    };

    // B-283: `/btw` is a web command on Claude sessions. This is the ONLY exit
    // to the main conversation for queued items (auto-release, edit-and-save,
    // intervene, persisted-queue reload), so the routing lives here too.
    const routeBtw = (text: string): boolean => {
        if (!canOfferBtw(session)) return false;
        const btw = parseBtwCommand(text);
        if (!btw) return false;
        openBtwPanel(sessionId, btw.question);
        return true;
    };

    const sendQueuedItem = async (item: QueuedMessage, delivery: 'queue' | 'steer' = 'queue') => {
        if (routeBtw(item.text)) {
            releaseQueuedAttachments(item);
            return;
        }
        await deliverQueuedMessage(() => sync.sendMessage(sessionId, item.text, {
            source: 'chat',
            delivery,
            attachments: item.attachments,
            modeMeta: item.modeMeta,
        }), () => releaseQueuedAttachments(item));
    };

    const doAbort = async (): Promise<AbortOutcome> => {
        if (aborting) return 'failed';
        setAborting(true);
        const started = Date.now();
        try {
            await sessionAbort(sessionId);
            return 'ok';
        } catch (error) {
            // B-320: never swallow. See ./abortOutcome.ts for why timeout and
            // failure must be told apart before they reach the user.
            return abortOutcomeForError(error);
        } finally {
            const elapsed = Date.now() - started;
            if (elapsed < 300) await new Promise((r) => setTimeout(r, 300 - elapsed));
            setAborting(false);
        }
    };

    const doSend = async (delivery: 'queue' | 'steer' = 'queue') => {
        const draft = draftRef.current;
        const value = draft.trim();
        if ((!value && attachments.length === 0) || sendingRef.current || processingAttachments) return;
        if (pending) {
            // B-516: no session yet — queue into the pending outbox. Attachments
            // and `/btw` need a live session; the text stays put for them.
            if (!value || attachments.length > 0) return;
            if (parseBtwCommand(value)) {
                toast.show(t('pendingSession.btwLater'), 'info');
                return;
            }
            if (!pending.onSend(value)) {
                if (pending.blockedHint) toast.show(pending.blockedHint, 'info');
                return;
            }
            draftRef.current = '';
            setText('');
            storage.getState().updateSessionDraft(sessionId, null);
            requestAnimationFrame(() => taRef.current?.focus());
            return;
        }
        if (!session) return;
        // B-283: `/btw [question]` opens the side-question panel and NEVER
        // reaches the main conversation (attachments stay in the composer).
        // Non-Claude sessions keep sending the text verbatim.
        if (routeBtw(value)) {
            setText('');
            draftRef.current = '';
            storage.getState().updateSessionDraft(sessionId, null);
            return;
        }
        // Captured BEFORE the async send: did the textarea own focus (⇒ the
        // soft keyboard was up) when the user hit send? On iOS, tapping a
        // button does NOT move focus off the textarea, so this stays true for
        // the normal "keyboard up, tap send" flow — and false when the user
        // had already put the keyboard away and taps send afterwards. In that
        // second case a refocus outside the gesture stack would NOT re-open
        // the keyboard but WOULD leave "focused textarea, no keyboard" — a
        // dead state where the next tap fires no focus event and the keyboard
        // can't be summoned. Mobile-only; desktop always refocuses.
        const hadFocus = document.activeElement === taRef.current;
        sendingRef.current = true;
        setSending(true);
        const createdAt = Date.now();
        let takenAttachments: QueuedMessage['attachments'];
        let draftTaken = false;
        let queueOwnsItem = false;
        try {
            // Take only this submission before yielding. The user may start a
            // new draft or attach another file while the request is in flight.
            takenAttachments = attachments.length > 0 ? take() : undefined;
            draftRef.current = '';
            setText('');
            draftTaken = true;
            // Clear the submitted draft in the same transaction. A late write
            // after the frame could overwrite a freshly remounted composer's
            // draft for this session.
            storage.getState().updateSessionDraft(sessionId, null);
            const makeItem = (): QueuedMessage => ({
                id: randomUUID(),
                text: value,
                createdAt,
                modeMeta: resolveMessageModeMeta(session, storage.getState().settings),
                attachments: takenAttachments,
            });
            let serverQueueOwnsItem = false;
            if (gate === 'restore-first' || (isWorking && delivery === 'queue')) {
                if (serverQueue && !takenAttachments) {
                    // B-509: durable from the server's acceptance on; until then
                    // the draft is restored by the catch below like any failed send.
                    serverQueueOwnsItem = true;
                } else {
                    // Queue ownership must transfer in the click stack: navigating
                    // away during the frame must not lose an accepted submission.
                    const next = [...queuedRef.current, makeItem()];
                    persistSessionQueue(sessionId, next);
                    queuedRef.current = next;
                    setQueued(next);
                    queueOwnsItem = true;
                }
            }
            // A resolved promise / one rAF resumes before paint. Yield through
            // the frame instead, so busy is visible before relay/restore work.
            // The release effect also waits for this submission's feedback.
            await yieldForSendFeedback();

            if (serverQueueOwnsItem) {
                const item = makeItem();
                let outcome: 'queued' | 'unsupported';
                try {
                    outcome = await enqueuePrompt(sessionId, item.text, item.modeMeta);
                } catch (error) {
                    toast.error(t('session.chat.queueDeliveryFailed'));
                    throw error;
                }
                if (outcome === 'unsupported') {
                    // Old server: this session falls back to the tab-local queue.
                    const next = [...queuedRef.current, item];
                    persistSessionQueue(sessionId, next);
                    queuedRef.current = next;
                    setQueued(next);
                }
                queueOwnsItem = true;
                if (gate === 'restore-first') void restoreSession(sessionId);
                return;
            }

            if (queueOwnsItem) {
                // Its existing restore/idle gate owns eventual queue delivery.
                if (gate === 'restore-first') void restoreSession(sessionId);
                return;
            }

            await sendQueuedItem(makeItem(), delivery);
        } catch {
            // Preserve the exact failed draft and any text/files composed
            // meanwhile, including attachment-only sends and preflight errors.
            if (draftTaken && !queueOwnsItem) {
                const current = draftRef.current;
                const restoredDraft = mergeRestoredDraft(draft, current);
                draftRef.current = restoredDraft;
                setText(restoredDraft);
            }
            if (takenAttachments && !queueOwnsItem) restore(takenAttachments);
        } finally {
            sendingRef.current = false;
            setSending(false);
            if (hadFocus || !IS_COARSE_POINTER) {
                requestAnimationFrame(() => taRef.current?.focus());
            }
        }
    };

    const interveneQueued = async (id: string) => {
        if (!supportsSteer || !isWorking || editingId === id || deliveryPhaseRef.current === 'intervening' || sendingRef.current) return;
        const index = queuedRef.current.findIndex((item) => item.id === id);
        if (index < 0) return;
        const item = queuedRef.current[index];
        deliveryPhaseRef.current = 'intervening';
        setInterveningId(id);
        setQueued((current) => removeQueuedMessage(current, id));
        try {
            await sendQueuedItem(item, 'steer');
            deliveryPhaseRef.current = 'waiting-start';
            waitingStartSinceRef.current = Date.now();
        } catch {
            deliveryPhaseRef.current = 'failed';
            setQueued((current) => [...current.slice(0, index), item, ...current.slice(index)]);
            toast.error(t('session.chat.queueDeliveryFailed'));
        } finally {
            setInterveningId(null);
        }
    };

    // B-509 server-queue actions. Steer = take the item off the server FIRST
    // (an item the wrapper already popped is a message now; steering it again
    // would run it twice), then send it into the live turn.
    const [serverBusyId, setServerBusyId] = useState<string | null>(null);
    const interveneServerQueued = async (id: string) => {
        if (!supportsSteer || !isWorking || editingId === id || serverBusyId !== null || sendingRef.current) return;
        const entry = serverQueueState.items.find((item) => item.id === id);
        if (!entry) return;
        setServerBusyId(id);
        try {
            const removed = await removePrompt(sessionId, id);
            if (!removed) {
                toast.error(t('session.chat.queueCancelTooLate'));
                return;
            }
            await deliverQueuedMessage(() => sync.sendMessage(sessionId, entry.text, {
                source: 'chat',
                delivery: 'steer',
                modeMeta: entry.modeMeta,
            }), () => {});
        } catch {
            toast.error(t('session.chat.queueDeliveryFailed'));
        } finally {
            setServerBusyId(null);
        }
    };
    const saveServerEdit = async (id: string, text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        setServerBusyId(id);
        try {
            const updated = await updatePromptText(sessionId, id, trimmed);
            if (!updated) toast.error(t('session.chat.queueCancelTooLate'));
        } catch {
            toast.error(t('session.chat.queueEditFailed'));
        } finally {
            setServerBusyId(null);
            setEditingId(null);
        }
    };
    const deleteServerQueued = async (id: string) => {
        setServerBusyId(id);
        try {
            await removePrompt(sessionId, id);
        } catch {
            toast.error(t('session.chat.queueCancelFailed'));
        } finally {
            setServerBusyId(null);
            if (editingId === id) setEditingId(null);
        }
    };
    const moveServerQueued = async (id: string, delta: -1 | 1) => {
        setServerBusyId(id);
        try {
            await movePrompt(sessionId, id, delta);
        } catch {
            toast.error(t('session.chat.queueEditFailed'));
        } finally {
            setServerBusyId(null);
        }
    };

    // B-509 review: a wrapper that never pops the queue (CLI rolled back but the
    // session's capability stayed; wrapper wedged) would leave prompts sitting
    // on the server forever while the agent shows idle. After 30 s of
    // 「idle + items」 the composer says so and offers to send the head now.
    const [serverQueueStale, setServerQueueStale] = useState(false);
    const serverQueueHasItems = serverQueue && serverQueueState.items.length > 0;
    useEffect(() => {
        if (!serverQueueHasItems || isWorking || gate === 'restore-first') {
            setServerQueueStale(false);
            return;
        }
        const timer = setTimeout(() => setServerQueueStale(true), PROMPT_QUEUE_STALE_MS);
        return () => clearTimeout(timer);
    }, [serverQueueHasItems, isWorking, gate, serverQueueState.items[0]?.id]);
    const sendServerHeadNow = async () => {
        const entry = serverQueueState.items[0];
        if (!entry || serverBusyId !== null || sendingRef.current) return;
        setServerBusyId(entry.id);
        try {
            // Off the server FIRST (a wrapper that wakes up must not run it too), then a plain send.
            const removed = await removePrompt(sessionId, entry.id);
            if (!removed) return;
            await deliverQueuedMessage(() => sync.sendMessage(sessionId, entry.text, {
                source: 'chat',
                delivery: 'queue',
                modeMeta: entry.modeMeta,
            }), () => {});
        } catch {
            toast.error(t('session.chat.queueDeliveryFailed'));
        } finally {
            setServerBusyId(null);
        }
    };

    // B-509: a session that just gained the server queue moves its tab-local
    // text items over once (attachment items stay local: not persisted anyway).
    useEffect(() => {
        if (!serverQueue || serverQueueState.status !== 'ready') return;
        const legacy = queuedRef.current.filter((item) => !item.attachments?.length);
        if (legacy.length === 0) return;
        void (async () => {
            for (const item of legacy) {
                try {
                    // The legacy item's id is the server localId: a second tab
                    // migrating the same item hits the idempotent path, not a duplicate.
                    if (await enqueuePrompt(sessionId, item.text, item.modeMeta, item.id) !== 'queued') return;
                } catch {
                    return;
                }
                setQueued((current) => removeQueuedMessage(current, item.id));
            }
        })();
    }, [serverQueue, serverQueueState.status, sessionId]);

    const deleteQueued = (id: string) => {
        const item = queuedRef.current.find((candidate) => candidate.id === id);
        if (item) releaseQueuedAttachments(item);
        if (deliveryPhaseRef.current === 'failed' && queuedRef.current[0]?.id === id) deliveryPhaseRef.current = 'idle';
        setQueued((current) => removeQueuedMessage(current, id));
        if (editingId === id) setEditingId(null);
    };

    // Release one queued message per agent turn. Removing the item before the
    // async send makes the action idempotent across renders; a failed send is
    // restored at the head for an explicit retry.
    useEffect(() => {
        deliveryPhaseRef.current = advanceQueueDeliveryPhase(
            deliveryPhaseRef.current,
            isWorking,
            waitingStartSinceRef.current === null ? 0 : Date.now() - waitingStartSinceRef.current,
        );
        if (deliveryPhaseRef.current !== 'waiting-start') waitingStartSinceRef.current = null;
        if (sendingRef.current) return;
        // B-265: hold while archived AND while a restore is still settling
        // (the store entry is dropped once presence held 'online' for 2 s).
        const releaseGate = gate === 'restore-first' || (restoreState && restoreState.phase !== 'failed') ? 'restore-first' : 'send';
        if (!canReleaseQueuedMessage(deliveryPhaseRef.current, isWorking, releaseGate, editingId !== null) || queued.length === 0) return;

        const item = queued[0];
        // B-509: with the server queue on, text items are migrated there (effect
        // above) and released by the wrapper — never from this tab.
        if (serverQueue && !item.attachments?.length) return;
        deliveryPhaseRef.current = 'waiting-start';
        waitingStartSinceRef.current = Date.now();
        setQueued((current) => current.slice(1));
        void sendQueuedItem(item).catch(() => {
            deliveryPhaseRef.current = 'failed';
            setQueued((current) => [item, ...current]);
            toast.error(t('session.chat.queueDeliveryFailed'));
        });
    }, [isWorking, queued, sessionId, gate, restoreState, stuckTick, editingId, sending, serverQueue]);

    // B-322: the timeout above needs a clock of its own. Being stuck in
    // `waiting-start` is by definition the case where nothing changes, so
    // nothing re-runs the effect and the escape edge would never be evaluated.
    // One timer, armed only while actually waiting with a non-empty queue.
    useEffect(() => {
        if (deliveryPhaseRef.current !== 'waiting-start' || queued.length === 0) return;
        const timer = setTimeout(() => setStuckTick((n) => n + 1), QUEUE_START_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [queued, stuckTick, isWorking]);

    // B-509: one list for the composer. Server items first (the wrapper runs
    // them in this order); tab-local items (old wrapper, or attachments) after.
    const queueRows: Array<{ id: string; text: string; source: 'server' | 'local' }> = serverQueue
        ? [
            ...serverQueueState.items.map((item) => ({ id: item.id, text: item.text, source: 'server' as const })),
            ...queued.filter((item) => !!item.attachments?.length).map((item) => ({ id: item.id, text: item.text, source: 'local' as const })),
        ]
        : queued.map((item) => ({ id: item.id, text: item.text, source: 'local' as const }));

    // Focus the textarea with the caret at the end — after an insert the next
    // keystroke (Enter to send, or more typing) must land after the new text.
    const focusComposerEnd = () => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    };

    const insertPreset = (presetText: string) => {
        setText((prev) => (prev.trim().length === 0 ? presetText : `${prev.replace(/\s*$/, '')}\n${presetText}`));
        requestAnimationFrame(focusComposerEnd);
    };

    // Insert target for the notes dock (vh:insert-to-input) — same semantics
    // as picking a preset: append, never send. Latest closure via ref so the
    // listener binds once.
    const insertPresetRef = useRef(insertPreset);
    insertPresetRef.current = insertPreset;
    useEffect(() => onInsertToInput((textToInsert) => insertPresetRef.current(textToInsert)), []);

    const onPickFiles = () => fileInputRef.current?.click();

    const addAttachmentFiles = async (files: File[]) => {
        const allowedFiles = supportsAnyAttachments
            ? files
            : files.filter((file) => {
                const type = file.type.toLowerCase();
                return SUPPORTED_IMAGE_MIME_TYPES.includes(type as typeof SUPPORTED_IMAGE_MIME_TYPES[number])
                    || (supportsPdfAttachments && (type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')));
            });
        const blockedFiles = files.filter((file) => !allowedFiles.includes(file));
        const result = await addFiles(allowedFiles);
        if (result.tooLarge.length > 0) {
            Modal.alert(
                t('imageUpload.fileTooLargeTitle'),
                t('imageUpload.fileTooLargeMessage', { name: result.tooLarge[0].name, maxMb: 50 }),
            );
        } else if (blockedFiles.length > 0) {
            Modal.alert(
                t('imageUpload.pdfRequiresCliTitle'),
                t('imageUpload.pdfRequiresCliMessage'),
            );
        } else if (result.unsupported.length > 0) {
            Modal.alert(
                t('imageUpload.unsupportedFileTitle'),
                t('imageUpload.unsupportedFileMessage'),
            );
        }
    };

    const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length) void addAttachmentFiles(files);
        e.target.value = '';
    };

    const onPaste = (e: React.ClipboardEvent) => {
        if (!supportsAttachments) {
            if (pending && getFilesFromClipboard(e.nativeEvent).length > 0) {
                e.preventDefault();
                toast.show(t('pendingSession.attachmentsLater'), 'info');
            }
            return;
        }
        const files = getFilesFromClipboard(e.nativeEvent);
        if (files.length) {
            e.preventDefault();
            void addAttachmentFiles(files);
        }
    };

    const onDrop = (e: React.DragEvent) => {
        setDragOver(false);
        const hasFiles = Array.from(e.dataTransfer.types).includes('Files');
        if (hasFiles) {
            e.preventDefault();
            if (pending) {
                toast.show(t('pendingSession.attachmentsLater'), 'info');
                return;
            }
            if (!supportsAttachments) {
                Modal.alert(t('imageUpload.notSupportedTitle'), t('imageUpload.notSupportedMessage'));
                return;
            }
            const files = getFilesFromDrop(e.nativeEvent);
            if (files.length) void addAttachmentFiles(files);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // IME guard — never send mid-composition (critical for Chinese input).
        // useImeGuard combines the local composing flag, isComposing/'Process'
        // on the event, and the post-compositionend window (Safari fires the
        // committing Enter AFTER compositionend with isComposing false).
        if (slashSuggestions.length > 0 && !ime.isGuarded(e)) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                setSlashIndex((current) => (current + delta + slashSuggestions.length) % slashSuggestions.length);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setDismissedSlashText(text);
                return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)) {
                e.preventDefault();
                const next = slashCommandText(slashSuggestions[slashIndex] ?? slashSuggestions[0]);
                setText(next);
                setDismissedSlashText(next);
                requestAnimationFrame(() => taRef.current?.focus());
                return;
            }
        }
        // Enter policy (desktop Enter sends / Cmd·Ctrl·Shift+Enter newline;
        // soft keyboards always newline) lives in resolveComposerEnter.
        // Steering stays on the queued message's own action.
        const action = resolveComposerEnter(e, { guarded: ime.isGuarded(e), enterToSend, softKeyboard: isSoftKeyboardDevice() });
        if (action === 'send') {
            e.preventDefault();
            void doSend('queue');
        } else if (action === 'newline') {
            e.preventDefault();
            insertComposerNewline(e.currentTarget);
        }
    };

    const setMode = (
        fn: 'updateSessionModelMode' | 'updateSessionPermissionMode' | 'updateSessionEffortLevel',
        field: AgentDefaultField,
        key: string | null,
    ) => {
        if (pending) pending.onMode(field, key);
        else storage.getState()[fn](sessionId, key);
        const currentOverrides = storage.getState().settings.agentDefaultOverrides;
        sync.applySettings({
            agentDefaultOverrides: setAgentDefaultOverride(currentOverrides, flavor, field, key),
        });
    };

    const setEffort = (key: string) => {
        if (isClaudeFlavor && key === EFFORT_DEFAULT_KEY) {
            setMode('updateSessionEffortLevel', 'effortLevel', null);
        } else {
            setMode('updateSessionEffortLevel', 'effortLevel', key);
        }
    };

    const setPermissionMode = async (key: string) => {
        if (permissionModeBusy) return;
        let appliedKey = key;
        if (supportsLivePermissionMode) {
            setPermissionModeBusy(true);
            // Mirror into the store so web-side yolo enforcement/alignment
            // never races the user's own mode change (B-262).
            storage.getState().setPermissionModeBusy(sessionId, true);
            try {
                const response = await sessionSetPermissionMode(sessionId, key);
                appliedKey = response.mode;
            } catch {
                Modal.alert(t('common.error'), t('session.chat.permissionModeChangeFailed'));
                return;
            } finally {
                setPermissionModeBusy(false);
                storage.getState().setPermissionModeBusy(sessionId, false);
            }
        }
        setMode('updateSessionPermissionMode', 'permissionMode', appliedKey);
    };

    const hasDraft = text.trim().length > 0 || attachments.length > 0 || processingAttachments;
    const canSend = hasDraft && !sending && !processingAttachments;

    return (
        <div className="ci" style={{ paddingBottom: 'max(var(--sp-3), env(safe-area-inset-bottom))' }}>
            <ComposerAttachments attachments={attachments} onRemove={remove} />

            {isPiAgent(flavor) && attachments.some((attachment) => attachment.mimeType.startsWith('image/')) && (
                <p className="ci-attachment-hint">{t('imageUpload.visionModelHint')}</p>
            )}

            {queueRows.length > 0 && (
                <section className="ci-queue" aria-label={t('session.chat.queueTitle')} data-queue-source={serverQueue ? 'server' : 'local'}>
                    <div className="ci-queue-head sr-only">
                        <span>{t('session.chat.queueTitle')}</span>
                        <span className="ci-queue-count">{queueRows.length}</span>
                        <span className="ci-queue-device">{serverQueue ? t('session.chat.queueServerHint') : t('session.chat.queueDeviceHint')}</span>
                    </div>
                    {deliveryPhaseRef.current === 'failed' && <div className="ci-queue-failure" role="status">
                        <span>{t('session.chat.queueDeliveryFailed')}</span>
                        <button type="button" className="ci-queue-action ci-queue-action--retry" onClick={() => { deliveryPhaseRef.current = 'idle'; setStuckTick(value => value + 1); }}>{t('common.retry')}</button>
                    </div>}
                    {serverQueueStale && <div className="ci-queue-failure" role="status" data-queue-stale>
                        <span>{t('session.chat.queueNotConsumed')}</span>
                        <button type="button" className="ci-queue-action ci-queue-action--retry" disabled={serverBusyId !== null} onClick={() => void sendServerHeadNow()}>{t('session.chat.queueSendNow')}</button>
                    </div>}
                    <div className="ci-queue-list">
                        {queueRows.map((row, index) => {
                            const busy = row.source === 'server' && serverBusyId === row.id;
                            const saveEdit = () => {
                                if (!editingText.trim()) return;
                                if (row.source === 'server') void saveServerEdit(row.id, editingText);
                                else {
                                    setQueued((current) => updateQueuedMessage(current, row.id, editingText));
                                    setEditingId(null);
                                }
                            };
                            return (
                            <div className="ci-queue-item" key={`${row.source}:${row.id}`} data-queue-item-source={row.source} aria-busy={busy}>
                                <ListEnd className="ci-queue-index" size={17} aria-hidden />
                                {editingId === row.id ? (
                                    <textarea
                                        className="ci-queue-edit"
                                        value={editingText}
                                        rows={2}
                                        autoFocus
                                        aria-label={t('session.chat.queueEdit')}
                                        placeholder={t('session.chat.queueEditingPlaceholder')}
                                        onChange={(event) => setEditingText(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (isImeGuardedEvent(event)) return;
                                            if (event.key === 'Escape') { setEditingId(null); return; }
                                            const action = resolveComposerEnter(event, { guarded: false, enterToSend, softKeyboard: isSoftKeyboardDevice() });
                                            if (action === 'send') { event.preventDefault(); if (editingText.trim()) saveEdit(); }
                                            else if (action === 'newline') { event.preventDefault(); insertComposerNewline(event.currentTarget); }
                                        }}
                                    />
                                ) : (
                                    <span className="ci-queue-text">{row.text || t('session.chat.attachmentOnly')}</span>
                                )}
                                <div className="ci-queue-actions">
                                    {editingId === row.id ? (
                                        <button
                                            type="button"
                                            className="ci-queue-action"
                                            disabled={!editingText.trim() || busy}
                                            onClick={saveEdit}
                                            aria-label={t('session.chat.queueSave')}
                                            title={t('session.chat.queueSave')}
                                        >{busy ? <Spinner size={14} /> : <Check size={15} />}</button>
                                    ) : (
                                        <DropdownMenu.Root>
                                            <DropdownMenu.Trigger asChild>
                                                <button type="button" className="ci-queue-action" disabled={busy} aria-label={t('session.chat.queueMore')} title={t('session.chat.queueMore')}>{busy ? <Spinner size={14} /> : <MoreHorizontal size={16} />}</button>
                                            </DropdownMenu.Trigger>
                                            <DropdownMenu.Portal>
                                                <DropdownMenu.Content className="pm-content" side="top" align="end" sideOffset={8}>
                                                    <DropdownMenu.Item className="pm-item" onSelect={() => { setEditingId(row.id); setEditingText(row.text); }}><Pencil size={14} />{t('session.chat.queueEdit')}</DropdownMenu.Item>
                                                    {row.source === 'server' && index > 0 && (
                                                        <DropdownMenu.Item className="pm-item" onSelect={() => void moveServerQueued(row.id, -1)}><ChevronUp size={14} />{t('session.chat.queueMoveUp')}</DropdownMenu.Item>
                                                    )}
                                                    {row.source === 'server' && index < serverQueueState.items.length - 1 && (
                                                        <DropdownMenu.Item className="pm-item" onSelect={() => void moveServerQueued(row.id, 1)}><ChevronDown size={14} />{t('session.chat.queueMoveDown')}</DropdownMenu.Item>
                                                    )}
                                                    <DropdownMenu.Label className="pm-head">{row.source === 'server' ? t('session.chat.queueServerHint') : t('session.chat.queueDeviceHint')}</DropdownMenu.Label>
                                                </DropdownMenu.Content>
                                            </DropdownMenu.Portal>
                                        </DropdownMenu.Root>
                                    )}
                                    <button
                                        type="button"
                                        className="ci-queue-action"
                                        disabled={busy}
                                        onClick={() => { if (row.source === 'server') void deleteServerQueued(row.id); else deleteQueued(row.id); }}
                                        aria-label={t('session.chat.queueDelete')}
                                        title={t('session.chat.queueDelete')}
                                    ><Trash2 size={15} /></button>
                                    {editingId === row.id && <button type="button" className="ci-queue-action" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={() => setEditingId(null)}><X size={16} /></button>}
                                    {supportsSteer && isWorking && editingId !== row.id && (
                                        <button
                                            type="button"
                                            className="ci-queue-action ci-queue-action--intervene"
                                            onClick={() => { if (row.source === 'server') void interveneServerQueued(row.id); else void interveneQueued(row.id); }}
                                            disabled={interveningId !== null || serverBusyId !== null}
                                            aria-busy={interveningId === row.id || busy}
                                            aria-label={t('session.chat.queueIntervene')}
                                            title={t('session.chat.queueIntervene')}
                                        >{interveningId === row.id || busy ? <Spinner size={14} /> : <CornerDownRight size={16} />}<span>{t('session.chat.queueIntervene')}</span></button>
                                    )}
                                </div>
                            </div>
                            );
                        })}
                    </div>
                </section>
            )}

            {slashSuggestions.length > 0 && (
                <div className="ci-slash" role="listbox" aria-label={t('session.chat.slashCommands')}>
                    <div className="ci-slash-head">{t('session.chat.slashCommands')}</div>
                    {slashSuggestions.map((item, index) => (
                        <button
                            key={item.command}
                            type="button"
                            role="option"
                            aria-selected={index === slashIndex}
                            className={`ci-slash-item${index === slashIndex ? ' ci-slash-item--active' : ''}`}
                            onMouseEnter={() => setSlashIndex(index)}
                            onClick={() => {
                                const next = slashCommandText(item);
                                setText(next);
                                setDismissedSlashText(next);
                                requestAnimationFrame(() => taRef.current?.focus());
                            }}
                        >
                            <span className="ci-slash-command">/{item.command}</span>
                            {item.description && <span className="ci-slash-desc">{item.description}</span>}
                        </button>
                    ))}
                </div>
            )}

            {/* composer */}
            <div
                className={`ci-composer${dragOver ? ' ci-composer--drag' : ''}`}
                onDragOver={(e) => {
                    if (Array.from(e.dataTransfer.types).includes('Files')) {
                        e.preventDefault();
                        setDragOver(true);
                    }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={supportsAnyAttachments ? undefined : [
                        ...SUPPORTED_IMAGE_MIME_TYPES,
                        ...(supportsPdfAttachments ? ['application/pdf', '.pdf'] : []),
                    ].join(',')}
                    multiple
                    style={{ display: 'none' }}
                    onChange={onFileInputChange}
                />
                <textarea
                    ref={taRef}
                    className="ci-textarea"
                    value={text}
                    rows={1}
                    placeholder={t('session.inputPlaceholder')}
                    onChange={(e) => { draftRef.current = e.target.value; setText(e.target.value); }}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    aria-label={t('common.message')}
                />
                <div className="ci-composer-toolbar">
                    <div className="ci-composer-tools">
                        <PresetsMenu onPick={insertPreset} onCancel={() => taRef.current?.focus()}
                            onAttach={supportsAttachments ? onPickFiles : undefined}
                            attachAnyFile={supportsAnyAttachments}
                            onExpand={expanded || text.length > 200 || text.includes('\n') ? toggleExpanded : undefined}
                            expanded={expanded} />
                        <ModeMenu
                            label={t('session.chat.permissionLabel')}
                            icon={<Shield size={18} aria-hidden />}
                            options={permModes}
                            value={permKey}
                            onChange={(key) => { void setPermissionMode(key); }}
                            busy={permissionModeBusy}
                            subtitle={permissionSubtitle}
                        />

                    </div>
                    <div className="ci-model-controls">
                    <ModelEffortMenu
                        label={t('session.chat.modelLabel')}
                        options={models}
                        value={displayedModelKey ?? null}
                        onChange={(key) => setMode('updateSessionModelMode', 'modelMode', key)}
                        subtitle={modelSubtitle}
                        effort={{ label: t('session.chat.effortLabel'), options: effortOptions, value: selectedEffortKey, onChange: setEffort }}
                    />
                    </div>
                    <div className="ci-composer-actions">
                        {isWorking && !sending && !processingAttachments && (!hasDraft || aborting) ? (
                            <button
                                type="button"
                                className="ci-send ci-send--abort"
                                onClick={() => {
                                    // B-320: the outcome MUST be consumed here.
                                    // This used to be `void doAbort()`, so every
                                    // failed stop was invisible.
                                    void doAbort().then((outcome) => {
                                        if (outcome === 'timeout') toast.error(t('session.chat.stopStillSettling'));
                                        else if (outcome === 'failed') toast.error(t('session.chat.stopFailed'));
                                        // B-509: Stop does not clear the server queue — say so, the
                                        // next item goes out as soon as the wrapper is idle.
                                        else if (serverQueue && serverQueueState.items.length > 0) toast.show(t('session.chat.queueStillPending', { count: serverQueueState.items.length }), 'info');
                                    });
                                }}
                                disabled={aborting}
                                aria-busy={aborting}
                                aria-label={t('session.chat.stop')}
                                title={t('session.chat.stop')}
                            >
                                {aborting ? <Spinner size={14} /> : <Square size={16} fill="currentColor" />}
                            </button>
                        ) : <button
                            type="button"
                            className="ci-send"
                            onClick={() => void doSend('queue')}
                            disabled={!canSend}
                            aria-busy={sending || processingAttachments}
                            aria-label={sending ? t('session.chat.sending') : gate === 'restore-first' ? t('restore.restoreAndSend') : isWorking ? t('session.chat.queueSend') : t('session.chat.send')}
                            title={gate === 'restore-first' ? t('restore.restoreAndSend') : isWorking ? t('session.chat.queueSend') : t('session.chat.send')}
                        >
                            {sending || processingAttachments ? <Spinner size={16} /> : <ArrowUp size={18} />}
                        </button>}
                    </div>
                </div>
            </div>

            <div className="ci-status">
                <div className={`ci-meter ci-meter--${meterTone}`} aria-label={t('session.chat.contextUsage')} title={contextKnown ? meterTitle : undefined}>
                    <Gauge size={14} aria-hidden />
                    <span>{percentUsed === null ? t('session.chat.contextUsage') : t('session.chat.contextMeter', { percent: Math.round(percentUsed) })}</span>
                    <span className="ci-meter-tokens">{contextTotal === null ? contextTokens : `${contextTokens} / ${contextTotal}`} tokens</span>
                </div>
                <span className="ci-hint">
                    {isWorking
                        ? supportsSteer ? t('session.chat.queueSteerHint') : t('session.chat.queueHint')
                        : isSoftKeyboardDevice() ? t('session.chat.touchEnterHint')
                        : enterToSend ? t('session.chat.enterToSend') : t('session.chat.shiftEnterToSend')}
                </span>
            </div>
        </div>
    );
}
