/**
 * FsPreviewOverlay — singleton host for `open_preview` pushes (B-131,
 * `specs/2026-08-open-preview.md` D3).
 *
 * Mounted once in AppLayout next to <ClipboardHistoryPanel />, opened
 * programmatically through the window event in sync/filePreviewOpen.ts (same
 * pattern as openClipboardHistory). Inside, it renders the already
 * self-contained <FsFileViewer>, so md / image / PDF / code rendering, chunked
 * reads and the failure states all come for free — FsBrowser is untouched, and
 * so are the two existing viewer hosts (terminal drawer, session FilesPanel).
 *
 * Deliberate behaviours:
 *  - when the preview belongs to a session / terminal context it docks into
 *    that page's resizable side panel instead (`previewDockTarget`), so you
 *    can read it and keep chatting; this overlay is the fallback only.
 *  - it does NOT steal focus (nothing is autofocused / .focus()'d): a push may
 *    land while the user is typing in a terminal or composer. Esc or a backdrop
 *    click closes it.
 *  - `mode: 'diff'` degrades to a plain preview plus a notice — diff rendering
 *    is B-036 and does not exist yet.
 *  - machine offline / unknown is called out EXPLICITLY (spec risk 2): fs-read
 *    needs the daemon, and an SDK session outlives its daemon, so "claude says
 *    it opened a preview, the user sees a blank box" is a real path. The check
 *    is reactive — when the machine comes back the viewer mounts by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useLocation, useNavigate } from 'react-router-dom';
import { previewDockTarget, previewJumpTarget, previewPinTarget, type PreviewSourceInfo } from './previewPinTarget';
import { jumpBlocker, lastTypingAt, trackTyping, typingHoldMs } from './previewInterrupt';
import { HIDDEN_PARK_MAX_MS, alreadyJumped, listenForJumps, previewKey, recordJump } from './previewJumpClaim';
import type { Session } from '@/sync/storageTypes';
import { toast } from '@/ui/Toast';
import { getSessionName } from '@/utils/sessionUtils';
import { storage, useMachine } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { onFsPreviewOpen, type FsPreviewRequest } from '@/sync/filePreviewOpen';
import { FsFileViewer } from './FsFileViewer';
import { setDownloadIntent } from './downloadIntent';
import { currentAutoDownloadEnv, shouldAutoDownload } from './fileDownload';
import { OVERLAY_PRIORITY, useOverlayTurn } from '@/app/overlayQueue';
import './fsbrowser.css';
import './filepreview.css';

/** Offline / unknown-machine stand-in: same head shape as the viewer's, so the
 *  path stays copy-visible and the overlay never shows a blank or a spinner. */
function UnreachableMachine({ request, fullscreen, onToggleFullscreen, onClose, message }: {
    request: FsPreviewRequest;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
    onClose: () => void;
    message: string;
}) {
    const { t } = useTranslation();
    return (
        <div className={`fsb-viewer${fullscreen ? ' fsb--full' : ''}`}>
            <div className="fsb-viewer-head">
                <span className="fsb-viewer-path" title={request.path}>{request.path}</span>
                <button
                    type="button"
                    className="fsb-iconbtn"
                    onClick={onToggleFullscreen}
                    aria-label={fullscreen ? t('fsBrowser.exitFullscreen') : t('fsBrowser.fullscreen')}
                    title={fullscreen ? t('fsBrowser.exitFullscreen') : t('fsBrowser.fullscreen')}
                >
                    {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                <button type="button" className="fsb-iconbtn" onClick={onClose} aria-label={t('common.back')} title={t('common.back')}>
                    <X size={15} />
                </button>
            </div>
            <div className="fsb-center">{message}</div>
        </div>
    );
}

/** B-918: the jump decision's view of a session row. */
export function previewSourceInfo(session: Session | undefined): PreviewSourceInfo | undefined {
    if (!session) return undefined;
    return { machineId: session.metadata?.machineId ?? undefined, archived: session.archivedAt != null, shared: !!session.share };
}

function PreviewBody({ request, fullscreen, onToggleFullscreen, onClose, onPin, sourceLabel }: {
    onPin?: () => void;
    sourceLabel?: string;
    request: FsPreviewRequest;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const machine = useMachine(request.machineId);

    if (!machine) {
        return (
            <UnreachableMachine
                request={request}
                fullscreen={fullscreen}
                onToggleFullscreen={onToggleFullscreen}
                onClose={onClose}
                message={t('filePreview.machineUnknown')}
            />
        );
    }
    if (!isMachineOnline(machine)) {
        return (
            <UnreachableMachine
                request={request}
                fullscreen={fullscreen}
                onToggleFullscreen={onToggleFullscreen}
                onClose={onClose}
                message={t('filePreview.machineOffline', { machine: machineLabel(machine) })}
            />
        );
    }

    return (
        <FsFileViewer
            sessionId={request.sessionId}
            onPin={onPin}
            sourceLabel={sourceLabel}
            machineId={request.machineId}
            path={request.path}
            onClose={onClose}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
        />
    );
}

export function FsPreviewOverlay() {
    const location = useLocation();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [request, setRequest] = useState<FsPreviewRequest | null>(null);
    const [fullscreen, setFullscreen] = useState(false);

    const close = useCallback(() => {
        setRequest(null);
        setFullscreen(false);
    }, []);

    const locationRef = useRef(location);
    locationRef.current = location;
    // B-918: page-wide keystroke clock (typing holds a jump) + sibling-tab claims.
    useEffect(() => { listenForJumps(); return trackTyping(document); }, []);
    /** The one jump in flight (typing wait / hidden-tab park); a newer push replaces it. */
    const pendingJump = useRef<(() => void) | null>(null);
    useEffect(() => () => pendingJump.current?.(), []);

    useEffect(() => {
        /** Open `next` in the CURRENT context: dock into this page's side panel
         *  when it serves the same machine, else the modal. Never another
         *  session's panel — moving you is previewJumpTarget's job alone. */
        function openHere(next: FsPreviewRequest) {
            const sessions = storage.getState().sessions;
            const dock = previewDockTarget({ ...next, sessionId: undefined }, locationRef.current, id => sessions[id]?.metadata?.machineId);
            if (dock) {
                setRequest(null);
                setFullscreen(false);
                navigate(dock);
                return;
            }
            // A second push replaces the first (one overlay, newest wins) and resets
            // the geometry so a stale fullscreen doesn't carry over.
            setRequest(next);
            setFullscreen(false);
        }

        /** Leave for the source session (history PUSH, so 「返回」 comes back here). */
        function go(next: FsPreviewRequest, key: string) {
            const sessions = storage.getState().sessions;
            const target = previewJumpTarget(next, locationRef.current.pathname, id => previewSourceInfo(sessions[id]));
            // You may have gone there yourself while it waited: then just open it there.
            if (!target) { openHere(next); return; }
            recordJump(key);
            setFullscreen(false);
            navigate(target);
            // Docked via ?pinFile= in the source's panel; otherwise (machine
            // mismatch) the modal opens over the source session.
            setRequest(target.includes('pinFile=') ? null : next);
        }

        /**
         * B-918 gates, in order: only a visible tab jumps (a hidden one parks the
         * push until it is shown, unless a sibling tab took it); a keystroke in
         * the last 2 s waits for 2 s of quiet, at most 10 s after arrival; an
         * open dialog / unsaved non-composer field asks first (B-772).
         */
        function scheduleJump(next: FsPreviewRequest) {
            pendingJump.current?.();
            const key = previewKey(next);
            const arrivedAt = Date.now();
            let timer: ReturnType<typeof setTimeout> | null = null;
            let parked = false;
            const cancel = () => {
                if (timer) clearTimeout(timer);
                if (parked) document.removeEventListener('visibilitychange', onVisible);
                timer = null; parked = false;
                if (pendingJump.current === cancel) pendingJump.current = null;
            };
            const onVisible = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisible); parked = false; step(); } };
            const step = () => {
                timer = null;
                if (alreadyJumped(key, arrivedAt)) { cancel(); return; }
                if (document.visibilityState === 'hidden') {
                    if (!parked) { parked = true; document.addEventListener('visibilitychange', onVisible); }
                    return;
                }
                if (Date.now() - arrivedAt > HIDDEN_PARK_MAX_MS) { cancel(); return; }
                const wait = typingHoldMs(Date.now(), lastTypingAt(), arrivedAt);
                if (wait > 0) { timer = setTimeout(step, wait); return; }
                cancel();
                if (jumpBlocker(document)) {
                    const source = next.sessionId ? storage.getState().sessions[next.sessionId] : undefined;
                    const name = source ? getSessionName(source) : t('filePreview.title');
                    toast.action(t('filePreview.pushHeld', { name }), () => { if (!alreadyJumped(key, arrivedAt)) go(next, key); });
                    return;
                }
                go(next, key);
            };
            pendingJump.current = cancel;
            step();
        }

        return onFsPreviewOpen((next: FsPreviewRequest) => {
            // B-562: record the download intent BEFORE docking/jumping, so the
            // viewer that mounts for this file (side panel or this overlay) finds it.
            if (next.intent === 'download') {
                setDownloadIntent({ machineId: next.machineId, path: next.path, auto: shouldAutoDownload(currentAutoDownloadEnv()) });
            }
            // B-918 (supersedes B-526 follow): a push from ANOTHER live session of
            // yours takes you there. Everything else — your own session, machine /
            // terminal pushes, archived or shared sources, previews you opened —
            // opens right here as before.
            const sessions = storage.getState().sessions;
            if (previewJumpTarget(next, locationRef.current.pathname, id => previewSourceInfo(sessions[id]))) {
                scheduleJump(next);
                return;
            }
            pendingJump.current?.();
            openHere(next);
        });
    }, [navigate, t]);

    /**
     * 焦点与 Esc（B-131 的一处设计修正）。
     *
     * `ClipboardHistoryPanel` 用的是 window capture 吞 Escape——那对它成立，因为它
     * **由用户主动打开**（⌘K / 设置）。本 overlay 是 **claude 推送、不请自来**的，
     * 照抄那套会有两个真实后果：①遮罩铺满视口，用户看不见终端却还在往里打字，
     * 击键落进一个看不见的目标；②本想给 vim 的 Esc 被我们吞掉。
     *
     * 既然遮罩已经是模态的（`inset: 0` + scrim），正确解是**接管焦点**：击键落进
     * overlay（无害、被丢弃）远好过落进看不见的终端（会变成一条残缺命令）。
     * 于是 Esc 也就自然属于 overlay，不需要全局 capture 那个 hack。
     */
    const panelRef = useRef<HTMLDivElement | null>(null);
    // B-831: an unasked-for, page-blocking push — it takes an `interaction`
    // turn (overlayQueue) instead of opening under the release notes' lock.
    const turn = useOverlayTurn(!!request, OVERLAY_PRIORITY.interaction);
    useEffect(() => {
        if (!request || !turn) return;
        panelRef.current?.focus();
    }, [request, turn]);

    if (!request || !turn || typeof document === 'undefined') return null;
    const pinTarget = previewPinTarget(request, location, id => storage.getState().sessions[id]?.metadata?.machineId);
    const sourceSession = request.fromPush && request.sessionId ? storage.getState().sessions[request.sessionId] : undefined;
    const sourceLabel = sourceSession ? getSessionName(sourceSession) : undefined;

    return createPortal(
        <div className="fpo-layer">
            <div className="fpo-backdrop" onClick={close} />
            <div
                ref={panelRef}
                className={`fpo-panel${fullscreen ? ' fpo-panel--full' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={t('filePreview.title')}
                tabIndex={-1}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        close();
                    }
                }}
            >
                {request.mode === 'diff' && (
                    <div className="fsb-notice fpo-notice">{t('filePreview.diffUnavailable')}</div>
                )}
                <PreviewBody
                    sourceLabel={sourceLabel}
                    onPin={pinTarget ? () => { navigate(pinTarget); close(); } : undefined}
                    request={request}
                    fullscreen={fullscreen}
                    onToggleFullscreen={() => setFullscreen((v) => !v)}
                    onClose={close}
                />
            </div>
        </div>,
        document.body,
    );
}
