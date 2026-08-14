/**
 * AgentInput — the composer. A big rounded auto-growing textarea + circular
 * send button, a clean status row (connection + always-visible context meter),
 * and model/permission/effort selectors on their own row.
 *
 * Sending: Enter sends (configurable via agentInputEnterToSend), Shift+Enter
 * inserts a newline. IME-safe: never sends while a composition is active.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Paperclip, Send, Square, X } from 'lucide-react';
import { sync } from '@/sync/sync';
import { sessionAbort } from '@/sync/ops';
import {
    useSession,
    useSessionUsage,
    useSessionRunningTool,
    useSetting,
    storage,
} from '@/sync/storage';
import { useSocketStatus } from '@/app/useConnection';
import { useTranslation } from '@/i18n/useTranslation';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
} from '@/components/modelModeOptions';
import { useImeGuard } from '@/utils/ime';
import { onInsertToInput } from '@/app/insertToInput';
import { normalizeAgentKey } from '@/sync/agentDefaults';
import { ModeMenu } from './ModeMenu';

// Sentinel key for the「默认」effort entry — not a real SDK effort level
// (the CLI validates against low/medium/high/xhigh/max, so this can never
// collide); picking it clears effortLevel and the wire carries effort:null.
const EFFORT_DEFAULT_KEY = 'default';
import { PresetsMenu } from './PresetsMenu';
import { useAttachments, getImagesFromClipboard, getImagesFromDrop } from './useAttachments';
import { contextPercentUsed } from './format';
import { composerHeightCap } from './composerExpand';
import './input.css';

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
    const socketStatus = useSocketStatus();
    const enterToSend = useSetting('agentInputEnterToSend');

    const taRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const ime = useImeGuard();
    const [text, setText] = useState(session?.draft ?? '');
    const [sending, setSending] = useState(false);
    const [aborting, setAborting] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    // B-098 手动展开态：上限 200px ↔ ~60% 视口高。会话内状态，刻意不持久化。
    const [expanded, setExpanded] = useState(false);
    const { attachments, addFiles, remove, clear } = useAttachments();

    const flavorForAttach = session?.metadata?.flavor;
    const supportsAttachments = !flavorForAttach || flavorForAttach === 'claude';

    const flavor = session?.metadata?.flavor as any;
    const metadata = session?.metadata ?? null;
    const online = session?.presence === 'online';
    const connected = online && socketStatus === 'connected';
    const isWorking = session?.thinking === true || !!runningTool;

    // selectors
    const models = getAvailableModels(flavor, metadata, t as any);
    const permModes = getAvailablePermissionModes(flavor, metadata, t as any);
    const modelKey = session?.modelMode ?? null;
    const efforts = getEffortLevelsForModel(flavor, modelKey ?? 'default');
    const permKey = session?.permissionMode ?? null;
    const effortKey = session?.effortLevel ?? null;
    // claude-ish flavors (incl. no flavor) support the explicit「默认」effort
    const isClaudeFlavor = normalizeAgentKey(flavor) === 'claude';

    // context meter — always visible when we have a usage snapshot.
    const contextSize = usage?.contextSize ?? 0;
    const percentUsed = contextPercentUsed(contextSize);
    const meterTone = percentUsed >= 95 ? 'crit' : percentUsed >= 90 ? 'warn' : 'ok';

    // grow textarea — 高度上限的唯一事实源是 composerHeightCap（B-098 收敛了
    // 原 JS 常量 + input.css max-height 的双定义）：上限也写回 inline style，
    // CSS 里不再有 max-height。展开态的上限每次重算，顺带跟上窗口尺寸变化。
    useLayoutEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        const cap = composerHeightCap(expanded, window.innerHeight);
        ta.style.maxHeight = `${cap}px`;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
    }, [text, expanded]);

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

    const doSend = async () => {
        const value = text.trim();
        const atts = attachments.length > 0 ? attachments : undefined;
        if ((!value && !atts) || sending) return;
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
        setSending(true);
        setText('');
        clear();
        storage.getState().updateSessionDraft(sessionId, null);
        try {
            await sync.sendMessage(sessionId, value, { source: 'chat', attachments: atts });
        } catch {
            // restore text on failure so the user doesn't lose it
            setText(value);
        } finally {
            setSending(false);
            if (hadFocus || !IS_COARSE_POINTER) {
                requestAnimationFrame(() => taRef.current?.focus());
            }
        }
    };

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

    const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length) void addFiles(files);
        e.target.value = '';
    };

    const onPaste = (e: React.ClipboardEvent) => {
        if (!supportsAttachments) return;
        const images = getImagesFromClipboard(e.nativeEvent);
        if (images.length) {
            e.preventDefault();
            void addFiles(images);
        }
    };

    const onDrop = (e: React.DragEvent) => {
        setDragOver(false);
        if (!supportsAttachments) return;
        const images = getImagesFromDrop(e.nativeEvent);
        if (images.length) {
            e.preventDefault();
            void addFiles(images);
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
        // useImeGuard combines the local composing flag, isComposing/'Process'
        // on the event, and the post-compositionend window (Safari fires the
        // committing Enter AFTER compositionend with isComposing false).
        if (e.key === 'Enter' && !e.shiftKey && !ime.isGuarded(e)) {
            if (enterToSend) {
                e.preventDefault();
                void doSend();
            }
        }
    };

    const setMode = (fn: 'updateSessionModelMode' | 'updateSessionPermissionMode' | 'updateSessionEffortLevel', key: string) => {
        storage.getState()[fn](sessionId, key);
    };

    const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending;

    return (
        <div className="ci" style={{ paddingBottom: 'max(var(--sp-3), env(safe-area-inset-bottom))' }}>
            {/* selector row */}
            <div className="ci-modes">
                <ModeMenu
                    label={t('session.chat.modelLabel')}
                    options={models}
                    value={modelKey}
                    onChange={(k) => setMode('updateSessionModelMode', k)}
                />
                <ModeMenu
                    label={t('session.chat.permissionLabel')}
                    options={permModes}
                    value={permKey}
                    onChange={(k) => setMode('updateSessionPermissionMode', k)}
                />
                {efforts.length > 0 && (
                    <ModeMenu
                        label={t('session.chat.effortLabel')}
                        // B-103: claude gets an explicit「默认」entry (= send
                        // nothing to the SDK → the machine's own adaptive
                        // default). Before this, a null effortLevel fell back
                        // to options[0] and the UI showed "low" while the CLI
                        // actually ran its own default — a straight-up lie.
                        options={isClaudeFlavor
                            ? [{ key: EFFORT_DEFAULT_KEY, name: t('session.chat.effortDefault'), description: t('session.chat.effortDefaultDesc') }, ...efforts]
                            : efforts}
                        value={isClaudeFlavor ? (effortKey ?? EFFORT_DEFAULT_KEY) : effortKey}
                        onChange={(k) => {
                            if (isClaudeFlavor && k === EFFORT_DEFAULT_KEY) {
                                storage.getState().updateSessionEffortLevel(sessionId, null);
                            } else {
                                setMode('updateSessionEffortLevel', k);
                            }
                        }}
                    />
                )}
            </div>

            {/* attachment previews */}
            {attachments.length > 0 && (
                <div className="ci-attachments">
                    {attachments.map((a) => (
                        <div key={a.id} className="ci-att">
                            <img className="ci-att-img" src={a.uri} alt={a.name} />
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

            {/* composer */}
            <div
                className={`ci-composer${dragOver ? ' ci-composer--drag' : ''}`}
                onDragOver={(e) => {
                    if (supportsAttachments) {
                        e.preventDefault();
                        setDragOver(true);
                    }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
            >
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
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
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
                {isWorking ? (
                    <button
                        type="button"
                        className="ci-send ci-send--abort"
                        onClick={() => void doAbort()}
                        disabled={aborting}
                        aria-label={t('session.chat.stop')}
                        title={t('session.chat.stop')}
                    >
                        <Square size={16} fill="currentColor" />
                    </button>
                ) : (
                    <button
                        type="button"
                        className="ci-send"
                        onClick={() => void doSend()}
                        disabled={!canSend}
                        aria-label={t('session.chat.send')}
                        title={t('session.chat.send')}
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
                        ? t('session.chat.connected')
                        : online
                            ? t('session.chat.reconnecting')
                            : t('session.chat.disconnected')}
                </span>
                <span className="ci-spacer" />
                <span className={`ci-meter ci-meter--${meterTone}`} title={t('session.chat.contextMeter', { percent: percentUsed })}>
                    <span className="ci-meter-track">
                        <span className="ci-meter-fill" style={{ width: `${percentUsed}%` }} />
                    </span>
                    <span className="ci-meter-label">{t('session.chat.contextLeft', { percent: 100 - percentUsed })}</span>
                </span>
                <span className="ci-hint">
                    {enterToSend ? t('session.chat.enterToSend') : t('session.chat.shiftEnterToSend')}
                </span>
            </div>
        </div>
    );
}
