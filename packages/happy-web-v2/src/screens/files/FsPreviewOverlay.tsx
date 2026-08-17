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
import { useMachine } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { onFsPreviewOpen, type FsPreviewRequest } from '@/sync/filePreviewOpen';
import { FsFileViewer } from './FsFileViewer';
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

function PreviewBody({ request, fullscreen, onToggleFullscreen, onClose }: {
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
            machineId={request.machineId}
            path={request.path}
            onClose={onClose}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
        />
    );
}

export function FsPreviewOverlay() {
    const { t } = useTranslation();
    const [request, setRequest] = useState<FsPreviewRequest | null>(null);
    const [fullscreen, setFullscreen] = useState(false);

    const close = useCallback(() => {
        setRequest(null);
        setFullscreen(false);
    }, []);

    useEffect(() => onFsPreviewOpen((next) => {
        // A second push replaces the first (one overlay, newest wins) and resets
        // the geometry so a stale fullscreen doesn't carry over.
        setRequest(next);
        setFullscreen(false);
    }), []);

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
    useEffect(() => {
        if (!request) return;
        panelRef.current?.focus();
    }, [request]);

    if (!request || typeof document === 'undefined') return null;

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
