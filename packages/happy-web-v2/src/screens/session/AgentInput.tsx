/**
 * AgentInput — the composer. A rounded auto-growing textarea + circular send
 * button, followed by one compact row for controls, context, and input hints.
 *
 * Sending: Enter sends (configurable via agentInputEnterToSend), Shift+Enter
 * inserts a newline. IME-safe: never sends while a composition is active.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, CornerDownRight, FileText, Maximize2, Minimize2, Paperclip, Pencil, Send, Square, Trash2, X } from 'lucide-react';
import { randomUUID } from 'expo-crypto';
import { sync } from '@/sync/sync';
import { sessionAbort, sessionSetPermissionMode } from '@/sync/ops';
import {
    useSession,
    useSessionUsage,
    useSessionRunningTool,
    useSetting,
    storage,
} from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    compactResolvedModelCode,
    relabelDefaultModel,
} from '@/components/modelModeOptions';
import { useImeGuard } from '@/utils/ime';
import { onInsertToInput } from '@/app/insertToInput';
import {
    normalizeAgentKey,
    resolveAgentDefaultConfig,
    setAgentDefaultOverride,
    type AgentDefaultField,
} from '@/sync/agentDefaults';
import { ModeMenu } from './ModeMenu';
import { SessionOptionsDialog } from './SessionOptionsDialog';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { loadQueuedMessages, saveQueuedMessages } from '@/sync/persistence';
import {
    advanceQueueDeliveryPhase,
    canReleaseQueuedMessage,
    parsePersistedQueuedMessages,
    persistableQueuedMessages,
    removeQueuedMessage,
    updateQueuedMessage,
    type QueuedMessage,
    type QueueDeliveryPhase,
} from './queuedMessages';
import { composerGate, restoreSession, useRestoreState } from '@/app/sessionRestore';

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
import { Spinner } from '@/ui';
import { contextPercentOf, contextWindowFor } from './contextWindow';
import { formatTokens } from './format';
import { getAllCommands } from '@/sync/suggestionCommands';
import { filterSlashSuggestions, slashCommandText } from './slashSuggestions';
import {
    COMPOSER_MOBILE_MIN_HEIGHT,
    composerHeightCap,
    composerTextareaHeight,
} from './composerExpand';
import './input.css';
import { shouldApplyPermissionModeLive } from './livePermissionMode';
import { derivePermissionModeDisplay } from './permissionModeDisplay';
import { resolveIntentSource } from '@/sync/yoloEnforcement';
import { getAgentDefaultOverride } from '@/sync/agentDefaults';

// Touch-first device — gates the conditional refocus below; desktop keeps the
// historical unconditional refocus (mouse-clicking Send should return the
// caret to the textarea).
const IS_COARSE_POINTER =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export function AgentInput({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const usage = useSessionUsage(sessionId);
    const runningTool = useSessionRunningTool(sessionId);
    const enterToSend = useSetting('agentInputEnterToSend');
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');

    const taRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const ime = useImeGuard();
    const [text, setText] = useState(session?.draft ?? '');
    const draftRef = useRef(text);
    draftRef.current = text;
    const [sending, setSending] = useState(false);
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
    const [sessionOptionsOpen, setSessionOptionsOpen] = useState(false);
    const [permissionModeBusy, setPermissionModeBusy] = useState(false);
    // B-098 手动展开态：上限 200px ↔ ~60% 视口高。会话内状态，刻意不持久化。
    const [expanded, setExpanded] = useState(false);
    const { attachments, processing: processingAttachments, addFiles, remove, clear, take, restore } = useAttachments();
    const queuedRef = useRef(queued);
    queuedRef.current = queued;
    const deliveryPhaseRef = useRef<QueueDeliveryPhase>('idle');

    useEffect(() => () => {
        for (const item of queuedRef.current) {
            for (const attachment of item.attachments ?? []) {
                if (attachment.uri?.startsWith('blob:')) URL.revokeObjectURL(attachment.uri);
            }
        }
    }, []);

    const flavorForAttach = session?.metadata?.flavor;
    const supportsAttachments = !flavorForAttach || flavorForAttach === 'claude';

    const flavor = session?.metadata?.flavor as any;
    const metadata = session?.metadata ?? null;
    const attachmentKinds = metadata?.attachmentKinds ?? [];
    const supportsAnyAttachments = attachmentKinds.includes('*/*');
    const supportsPdfAttachments = attachmentKinds.includes('application/pdf');
    const isWorking = session?.thinking === true || !!runningTool;
    // B-265: an archived session's composer restores first and queues; the
    // queue releases once the session is back (archivedAt cleared + online).
    const gate = composerGate(session);
    const restoreState = useRestoreState(sessionId);
    const hasPendingPermission = Object.keys(session?.agentState?.requests ?? {}).length > 0;
    const slashSuggestions = dismissedSlashText === text
        ? []
        : filterSlashSuggestions(getAllCommands(sessionId), text);

    useEffect(() => {
        setSlashIndex(0);
    }, [text, sessionId]);

    useEffect(() => {
        const all = loadQueuedMessages();
        const persisted = persistableQueuedMessages(queued);
        if (persisted.length > 0) all[sessionId] = persisted;
        else delete all[sessionId];
        saveQueuedMessages(all);
    }, [queued, sessionId]);

    // selectors
    const agentDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, flavor);
    const modelKey = session?.modelMode ?? agentDefaults.modelMode;
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
    const efforts = getEffortLevelsForModel(flavor, modelKey ?? 'default');
    const permKey = session?.permissionMode ?? agentDefaults.permissionMode;
    const effortKey = session?.effortLevel ?? agentDefaults.effortLevel;
    // claude-ish flavors (incl. no flavor) support the explicit「默认」effort
    const isClaudeFlavor = normalizeAgentKey(flavor) === 'claude';
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
    const effortOptions = isClaudeFlavor
        ? [{ key: EFFORT_DEFAULT_KEY, name: t('session.chat.effortDefault'), description: t('session.chat.effortDefaultDesc') }, ...efforts]
        : efforts;
    const selectedEffortKey = isClaudeFlavor ? (effortKey ?? EFFORT_DEFAULT_KEY) : effortKey;
    const selectedModel = models.find((option) => option.key === modelKey) ?? models[0];
    const selectedPermission = permModes.find((option) => option.key === permKey) ?? permModes[0];
    // B-262 A4: honest subtitle — what the CLI has confirmed vs. what we intend.
    const permissionDisplayState = isClaudeFlavor
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
    const sessionOptionsSummary = [selectedModel?.name, selectedPermission?.name]
        .filter(Boolean)
        .join(' · ');

    // context meter — always visible when we have a usage snapshot.
    const contextSize = usage?.contextSize ?? 0;
    // 分母按 assistant 消息回传的**真实**模型定（B-135）。拿不到模型就不显示百分比
    // ——宁可只给 token 绝对数，也不给一个看着正常却是错的百分比。
    const contextWindow = contextWindowFor(usage?.model);
    const percentUsed = contextPercentOf(contextSize, contextWindow);
    const contextTokens = formatTokens(contextSize);
    const contextTotal = contextWindow === null ? null : formatTokens(contextWindow);
    const meterTone = percentUsed === null ? 'ok' : percentUsed >= 95 ? 'crit' : percentUsed >= 90 ? 'warn' : 'ok';
    const meterTitle = percentUsed === null
        ? contextTokens
        : `${contextTokens} / ${contextTotal} · ${t('session.chat.contextMeter', { percent: percentUsed })}`;

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

    // persist draft (debounced via storage's own normalization)
    useEffect(() => {
        const id = setTimeout(() => storage.getState().updateSessionDraft(sessionId, text), 400);
        return () => clearTimeout(id);
    }, [text, sessionId]);

    // Route switches remount the composer by session id. Flush the latest
    // value before unmount so a sub-debounce draft stays with its own session.
    useEffect(() => () => {
        storage.getState().updateSessionDraft(sessionId, draftRef.current || null);
    }, [sessionId]);

    const releaseQueuedAttachments = (item: QueuedMessage) => {
        for (const attachment of item.attachments ?? []) {
            if (attachment.uri?.startsWith('blob:')) URL.revokeObjectURL(attachment.uri);
        }
    };

    const sendQueuedItem = async (item: QueuedMessage, delivery: 'queue' | 'steer' = 'queue') => {
        await sync.sendMessage(sessionId, item.text, {
            source: 'chat',
            delivery,
            attachments: item.attachments,
            modeMeta: item.modeMeta,
        });
        releaseQueuedAttachments(item);
    };

    const doAbort = async (): Promise<boolean> => {
        if (aborting) return false;
        setAborting(true);
        const started = Date.now();
        try {
            await sessionAbort(sessionId);
            return true;
        } catch {
            return false;
        } finally {
            const elapsed = Date.now() - started;
            if (elapsed < 300) await new Promise((r) => setTimeout(r, 300 - elapsed));
            setAborting(false);
        }
    };

    const doSend = async (delivery: 'queue' | 'steer' = 'queue') => {
        const value = text.trim();
        const atts = attachments.length > 0 ? attachments : undefined;
        if ((!value && !atts) || sending || !session) return;
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
        draftRef.current = '';
        const item: QueuedMessage = {
            id: randomUUID(),
            text: value,
            createdAt: Date.now(),
            modeMeta: resolveMessageModeMeta(session, storage.getState().settings),
            attachments: atts ? take() : undefined,
        };
        setText('');
        if (!atts) clear();
        storage.getState().updateSessionDraft(sessionId, null);

        if (gate === 'restore-first') {
            // Never write to an archived session: the message would sit on the
            // server unprocessed. Queue it locally and bring the session back.
            setQueued((current) => [...current, item]);
            void restoreSession(sessionId);
            if (hadFocus || !IS_COARSE_POINTER) requestAnimationFrame(() => taRef.current?.focus());
            return;
        }

        if (isWorking && delivery === 'queue') {
            setQueued((current) => [...current, item]);
            if (hadFocus || !IS_COARSE_POINTER) requestAnimationFrame(() => taRef.current?.focus());
            return;
        }

        setSending(true);
        try {
            await sendQueuedItem(item, delivery);
        } catch {
            // Restore the complete draft on failure so attachment-only sends
            // do not disappear after an upload or relay error.
            draftRef.current = value;
            setText(value);
            if (item.attachments) restore(item.attachments);
        } finally {
            setSending(false);
            if (hadFocus || !IS_COARSE_POINTER) {
                requestAnimationFrame(() => taRef.current?.focus());
            }
        }
    };

    const interveneQueued = async (id: string) => {
        if (!supportsSteer || deliveryPhaseRef.current === 'intervening' || sending) return;
        const index = queuedRef.current.findIndex((item) => item.id === id);
        if (index < 0) return;
        const item = queuedRef.current[index];
        deliveryPhaseRef.current = 'intervening';
        setInterveningId(id);
        setQueued((current) => removeQueuedMessage(current, id));
        try {
            await sendQueuedItem(item, 'steer');
            deliveryPhaseRef.current = 'waiting-start';
        } catch {
            setQueued((current) => [...current.slice(0, index), item, ...current.slice(index)]);
            deliveryPhaseRef.current = 'idle';
        } finally {
            setInterveningId(null);
        }
    };

    const deleteQueued = (id: string) => {
        const item = queuedRef.current.find((candidate) => candidate.id === id);
        if (item) releaseQueuedAttachments(item);
        setQueued((current) => removeQueuedMessage(current, id));
        if (editingId === id) setEditingId(null);
    };

    // Release one queued message per agent turn. Removing the item before the
    // async send makes the action idempotent across renders; a failed send is
    // restored at the head for an explicit retry.
    useEffect(() => {
        deliveryPhaseRef.current = advanceQueueDeliveryPhase(deliveryPhaseRef.current, isWorking);
        // B-265: hold while archived AND while a restore is still settling
        // (the store entry is dropped once presence held 'online' for 2 s).
        const releaseGate = gate === 'restore-first' || (restoreState && restoreState.phase !== 'failed') ? 'restore-first' : 'send';
        if (!canReleaseQueuedMessage(deliveryPhaseRef.current, isWorking, releaseGate) || queued.length === 0) return;

        const item = queued[0];
        deliveryPhaseRef.current = 'waiting-start';
        setQueued((current) => current.slice(1));
        void sendQueuedItem(item).catch(() => {
            setQueued((current) => [item, ...current]);
            deliveryPhaseRef.current = 'idle';
        });
    }, [isWorking, queued, sessionId, gate, restoreState]);

    const insertPreset = (presetText: string) => {
        setText((prev) => (prev.trim().length === 0 ? presetText : `${prev.replace(/\s*$/, '')}\n${presetText}`));
        requestAnimationFrame(() => taRef.current?.focus());
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
        if (!supportsAttachments) return;
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
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                const next = slashCommandText(slashSuggestions[slashIndex] ?? slashSuggestions[0]);
                setText(next);
                setDismissedSlashText(next);
                requestAnimationFrame(() => taRef.current?.focus());
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey && !ime.isGuarded(e)) {
            if (enterToSend) {
                e.preventDefault();
                void doSend(isWorking && supportsSteer && (e.metaKey || e.ctrlKey) ? 'steer' : 'queue');
            }
        }
    };

    const setMode = (
        fn: 'updateSessionModelMode' | 'updateSessionPermissionMode' | 'updateSessionEffortLevel',
        field: AgentDefaultField,
        key: string | null,
    ) => {
        storage.getState()[fn](sessionId, key);
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

    const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending && !processingAttachments;

    return (
        <div className="ci" style={{ paddingBottom: 'max(var(--sp-3), env(safe-area-inset-bottom))' }}>
            <div className="ci-mobile-options">
                <SessionOptionsDialog
                    open={sessionOptionsOpen}
                    onOpenChange={setSessionOptionsOpen}
                    triggerLabel={t('session.chat.sessionSettings')}
                    triggerSummary={sessionOptionsSummary}
                    title={t('session.chat.sessionSettingsTitle')}
                    description={t('session.chat.sessionSettingsDescription')}
                    closeLabel={t('common.close')}
                    model={{
                        label: t('session.chat.modelLabel'),
                        options: models,
                        value: modelKey,
                        onChange: (key) => setMode('updateSessionModelMode', 'modelMode', key),
                    }}
                    permission={{
                        label: t('session.chat.permissionLabel'),
                        options: permModes,
                        value: permKey,
                        onChange: (key) => { void setPermissionMode(key); },
                        busy: permissionModeBusy,
                        hint: permissionSubtitle,
                    }}
                    effort={{
                        label: t('session.chat.effortLabel'),
                        options: effortOptions,
                        value: selectedEffortKey,
                        onChange: setEffort,
                    }}
                />
            </div>

            {/* attachment previews */}
            {attachments.length > 0 && (
                <div className="ci-attachments">
                    {attachments.map((a) => (
                        <div key={a.id} className="ci-att">
                            {a.width === 0 || a.height === 0 ? (
                                <div className="ci-att-file" title={a.name}>
                                    <FileText size={20} />
                                    <span>{a.name}</span>
                                </div>
                            ) : (
                                <img className="ci-att-img" src={a.uri} alt={a.name} />
                            )}
                            <button
                                type="button"
                                className="ci-att-remove"
                                onClick={() => remove(a.id)}
                                aria-label={t('common.delete')}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {queued.length > 0 && (
                <section className="ci-queue" aria-label={t('session.chat.queueTitle')}>
                    <div className="ci-queue-head">
                        <span>{t('session.chat.queueTitle')}</span>
                        <span className="ci-queue-count">{queued.length}</span>
                        <span className="ci-queue-device">{t('session.chat.queueDeviceHint')}</span>
                    </div>
                    <div className="ci-queue-list">
                        {queued.map((item, index) => (
                            <div className="ci-queue-item" key={item.id}>
                                <span className="ci-queue-index">{String(index + 1).padStart(2, '0')}</span>
                                {editingId === item.id ? (
                                    <textarea
                                        className="ci-queue-edit"
                                        value={editingText}
                                        rows={2}
                                        autoFocus
                                        placeholder={t('session.chat.queueEditingPlaceholder')}
                                        onChange={(event) => setEditingText(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Escape') setEditingId(null);
                                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && editingText.trim()) {
                                                setQueued((current) => updateQueuedMessage(current, item.id, editingText));
                                                setEditingId(null);
                                            }
                                        }}
                                    />
                                ) : (
                                    <span className="ci-queue-text">{item.text || t('session.chat.attach')}</span>
                                )}
                                <div className="ci-queue-actions">
                                    {editingId === item.id ? (
                                        <button
                                            type="button"
                                            className="ci-queue-action"
                                            disabled={!editingText.trim()}
                                            onClick={() => {
                                                setQueued((current) => updateQueuedMessage(current, item.id, editingText));
                                                setEditingId(null);
                                            }}
                                            aria-label={t('session.chat.queueSave')}
                                            title={t('session.chat.queueSave')}
                                        ><Check size={15} /></button>
                                    ) : (
                                        <button
                                            type="button"
                                            className="ci-queue-action"
                                            onClick={() => { setEditingId(item.id); setEditingText(item.text); }}
                                            aria-label={t('session.chat.queueEdit')}
                                            title={t('session.chat.queueEdit')}
                                        ><Pencil size={14} /></button>
                                    )}
                                    <button
                                        type="button"
                                        className="ci-queue-action"
                                        onClick={() => deleteQueued(item.id)}
                                        aria-label={t('session.chat.queueDelete')}
                                        title={t('session.chat.queueDelete')}
                                    ><Trash2 size={15} /></button>
                                    {supportsSteer && isWorking && (
                                        <button
                                            type="button"
                                            className="ci-queue-action ci-queue-action--intervene"
                                            onClick={() => void interveneQueued(item.id)}
                                            disabled={interveningId !== null}
                                            aria-busy={interveningId === item.id}
                                            aria-label={t('session.chat.queueIntervene')}
                                            title={t('session.chat.queueIntervene')}
                                        >{interveningId === item.id ? <Spinner size={14} /> : <CornerDownRight size={16} />}</button>
                                    )}
                                </div>
                            </div>
                        ))}
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
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    aria-label={t('common.message')}
                />
                <div className="ci-composer-toolbar">
                    <div className="ci-composer-tools">
                        {supportsAttachments && (
                            <button
                                type="button"
                                className="ci-icon-btn"
                                onClick={onPickFiles}
                                aria-label={t('session.chat.attach')}
                                title={t('session.chat.attach')}
                            >
                                <Paperclip size={18} />
                            </button>
                        )}
                        <PresetsMenu onPick={insertPreset} onCancel={() => taRef.current?.focus()} />
                        <button
                            type="button"
                            className="ci-icon-btn"
                            onClick={toggleExpanded}
                            aria-pressed={expanded}
                            aria-label={expanded ? t('session.input.collapse') : t('session.input.expand')}
                            title={expanded ? t('session.input.collapse') : t('session.input.expand')}
                        >
                            {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                        </button>
                    </div>
                    <div className="ci-composer-actions">
                        {isWorking && (
                            <button
                                type="button"
                                className="ci-send ci-send--abort"
                                onClick={() => void doAbort()}
                                disabled={aborting}
                                aria-busy={aborting}
                                aria-label={t('session.chat.stop')}
                                title={t('session.chat.stop')}
                            >
                                {aborting ? <Spinner size={14} /> : <Square size={16} fill="currentColor" />}
                            </button>
                        )}
                        <button
                            type="button"
                            className="ci-send"
                            onClick={() => void doSend('queue')}
                            disabled={!canSend}
                            aria-busy={sending || processingAttachments}
                            aria-label={gate === 'restore-first' ? t('restore.restoreAndSend') : isWorking ? t('session.chat.queueSend') : t('session.chat.send')}
                            title={gate === 'restore-first' ? t('restore.restoreAndSend') : isWorking ? t('session.chat.queueSend') : t('session.chat.send')}
                        >
                            {sending || processingAttachments ? <Spinner size={16} /> : <Send size={16} />}
                        </button>
                    </div>
                </div>
            </div>

            {/* Desktop controls share one compact row with context and hints.
                Mobile keeps the touch-friendly SessionOptionsDialog above. */}
            <div className="ci-status">
                <div className="ci-modes">
                    <ModeMenu
                        label={t('session.chat.modelLabel')}
                        options={models}
                        value={modelKey}
                        onChange={(key) => setMode('updateSessionModelMode', 'modelMode', key)}
                    />
                    <ModeMenu
                        label={t('session.chat.permissionLabel')}
                        options={permModes}
                        value={permKey}
                        onChange={(key) => { void setPermissionMode(key); }}
                        busy={permissionModeBusy}
                        subtitle={permissionSubtitle}
                    />
                    {efforts.length > 0 && (
                        <ModeMenu
                            label={t('session.chat.effortLabel')}
                            options={effortOptions}
                            value={selectedEffortKey}
                            onChange={setEffort}
                        />
                    )}
                </div>
                <span className="ci-spacer" />
                <span className={`ci-meter ci-meter--${meterTone}`} title={meterTitle}>
                    {percentUsed !== null && (
                        <span className="ci-meter-track">
                            <span className="ci-meter-fill" style={{ width: `${percentUsed}%` }} />
                        </span>
                    )}
                    <span className="ci-meter-label">
                        {percentUsed === null
                            ? contextTokens
                            : `${contextTokens} / ${contextTotal}`}
                    </span>
                </span>
                <span className="ci-hint">
                    {isWorking
                        ? supportsSteer ? t('session.chat.queueSteerHint') : t('session.chat.queueHint')
                        : enterToSend ? t('session.chat.enterToSend') : t('session.chat.shiftEnterToSend')}
                </span>
            </div>
        </div>
    );
}
