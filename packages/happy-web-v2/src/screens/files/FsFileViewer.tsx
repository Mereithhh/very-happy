/**
 * FsFileViewer — renders one machine file fetched via the fs-read machine RPC.
 *
 * Per-kind rendering (extension-first, see fsPreviewModel):
 * - text  → CodeView (shiki highlight + copy), 512KB window with a truncation
 *   notice; the viewer BODY is the scroll container (code.css's 420px chat cap
 *   is undone in fsbrowser.css).
 * - markdown → the chat message Markdown pipeline, with a source/rendered
 *   toggle in the head.
 * - image / pdf → whole-file bytes assembled from chunked fs-read windows
 *   (assembleFsFile) and re-wrapped as a Blob URL — NOT a data: URI (iOS
 *   Safari rejects data URLs over ~3MB). Images toggle fit ↔ 100% on click;
 *   PDFs render in the browser's native viewer via <iframe>. Files over the
 *   10MB guardrail get a "too large" notice; old daemons that can't serve
 *   offset windows get an upgrade hint for multi-chunk files.
 *
 * The head shows the full path with a copy-path button, plus the host's
 * fullscreen toggle (owned by FsBrowser).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Code, Eye, ClipboardCopy, Download, PanelRightOpen, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { machineFsRead, type FsFailure } from '@/sync/fsOps';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { CopyButton } from '@/ui/CopyButton';
import { CodeView } from '../session/CodeView';
import { Markdown } from '../session/Markdown';
import { langForPath } from '../session/langForPath';
import { formatFsSize } from './fsBrowseModel';
import {
    FS_PREVIEW_CHUNK_BYTES,
    FS_PREVIEW_MAX_BYTES,
    assembleFsFile,
    previewKindOf,
    previewMimeOf,
} from './fsPreviewModel';
import { SpreadsheetPreview } from './SpreadsheetPreview';
import { HtmlPreviewFrame } from './HtmlPreviewFrame';
import { fsFailureText } from './fsFailureText';
import { DownloadFeedback, FileDownloadAction } from './FileDownloadAction';
import { useFileDownload } from './useFileDownload';
import { consumeDownloadIntent, useDownloadIntent } from './downloadIntent';
import { useSession, useSessionMessages } from '@/sync/storage';
import { changeAction, isNewWrite, lastAgentWriteAt } from './agentWrites';

type ViewerState =
    | { phase: 'loading'; progress: number | null }
    | { phase: 'failed'; failure: FsFailure }
    | { phase: 'too-large'; size: number }
    | { phase: 'needs-upgrade'; size: number }
    | { phase: 'binary'; size: number }
    | { phase: 'text'; text: string; size: number; truncated: boolean }
    | { phase: 'bytes'; bytes: Uint8Array; size: number };

function decodeUtf8(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function FsFileViewer(props: FsFileViewerProps) {
    return <FsFileViewerContent key={JSON.stringify([props.machineId, props.path])} {...props}/>;
}
/**
 * Leading-edge throttle: the first change after a quiet second passes at
 * once, later ones within the second are merged into one trailing update.
 */
function useThrottledValue<T>(value: T, ms: number): T {
    const [shown, setShown] = useState(value);
    const lastEmit = useRef(0);
    const current = useRef(value);
    useEffect(() => {
        if (Object.is(value, current.current)) return;   // the mount value is not an emission
        current.current = value;
        const wait = lastEmit.current + ms - Date.now();
        if (wait <= 0) { lastEmit.current = Date.now(); setShown(value); return; }
        const timer = setTimeout(() => { lastEmit.current = Date.now(); setShown(current.current); }, wait);
        return () => clearTimeout(timer);
    }, [value, ms]);
    return shown;
}

/** Throttle window for following a streaming session's writes (review 低3). */
const FOLLOW_THROTTLE_MS = 1000;

/**
 * B-573: completion time of this session's latest agent write to `path`
 * (null without a session — the machine file page has nothing to follow).
 * Messages are sampled at most once a second while a session streams, and
 * each message's writes are cached (agentWrites.ts).
 */
function useAgentLastWrite(sessionId: string | undefined, path: string): number | null {
    const { messages } = useSessionMessages(sessionId ?? '');
    const sampled = useThrottledValue(messages, FOLLOW_THROTTLE_MS);
    const metadata = useSession(sessionId ?? '')?.metadata;
    const cwd = metadata?.path;
    const home = metadata?.homeDir;
    return useMemo(() => (sessionId ? lastAgentWriteAt(sampled, path, cwd, home) : null), [sessionId, sampled, path, cwd, home]);
}

interface FsFileViewerProps {
    /** B-573: follow this session's agent writes to the file (refresh / banner). */
    sessionId?: string;
    onPin?: () => void;
    contained?: boolean;
    machineId: string;
    path: string;
    onClose: () => void;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
}
function FsFileViewerContent({ machineId, path, onClose, fullscreen, onToggleFullscreen, onPin, contained = false, sessionId }: FsFileViewerProps) {
    const { t, lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const kind = previewKindOf(path);
    const [state, setState] = useState<ViewerState>({ phase: 'loading', progress: null });
    // Whole-file bytes already assembled for the preview are reused, not read twice.
    const stateRef = useRef(state);
    stateRef.current = state;
    const preloaded = () => (stateRef.current.phase === 'bytes' ? stateRef.current.bytes : null);
    const headDownload = useFileDownload(machineId, path, zh);
    const downloading = headDownload.busy;
    const download = () => { if (!downloading) void headDownload.start(preloaded() ?? undefined); };
    // B-562: a pushed `open_preview(download: true)` for THIS file → prominent bar.
    const intent = useDownloadIntent(machineId, path);
    const [pushed, setPushed] = useState<{ auto: boolean } | null>(null);
    useEffect(() => {
        if (!intent) return;
        setPushed({ auto: intent.auto });
        consumeDownloadIntent(intent);
    }, [intent]);
    const knownSize = 'size' in state ? state.size : null;
    const unpreviewable = (title: string) => (
        <div className="fsb-center fsb-unpreviewable">
            <p className="fsb-unpreviewable-title">{title}</p>
            {knownSize != null && <span className="fsb-caption mono">{formatFsSize(knownSize)}</span>}
            {!pushed && <FileDownloadAction variant="block" machineId={machineId} path={path} size={knownSize} />}
        </div>
    );
    const [showSource, setShowSource] = useState(false);
    const [imgActual, setImgActual] = useState(false);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    // B-573: re-read when the agent writes this file. `silent` keeps the old
    // content on screen until the new one lands, then restores the scroll.
    const rootRef = useRef<HTMLDivElement>(null);
    const [reload, setReload] = useState<{ tick: number; silent: boolean }>({ tick: 0, silent: false });
    const restoreScroll = useRef<number | null>(null);
    const lastInteraction = useRef(0);
    const [agentChanged, setAgentChanged] = useState(false);
    const scroller = () => rootRef.current?.querySelector<HTMLElement>('.fsb-viewer-body') ?? null;
    // When the content on screen was read: only writes completed after it are news (review 中2).
    const readAt = useRef(Date.now());
    const refresh = (silent: boolean) => {
        setAgentChanged(false);
        readAt.current = Math.max(readAt.current, Date.now());
        restoreScroll.current = silent ? scroller()?.scrollTop ?? null : null;
        setReload((r) => ({ tick: r.tick + 1, silent }));
    };
    const lastWrite = useAgentLastWrite(sessionId, path);
    useEffect(() => {
        if (lastWrite === null || !isNewWrite(lastWrite, readAt.current)) return;
        // handled: a banner must not re-fire for the same write
        readAt.current = Math.max(readAt.current, lastWrite);
        const root = rootRef.current;
        const selection = typeof window !== 'undefined' ? window.getSelection() : null;
        const hasSelection = !!(root && selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode));
        const action = changeAction({
            phase: stateRef.current.phase,
            kind: kind === 'markdown' && showSource ? 'text' : kind,
            visible: !!root && root.getClientRects().length > 0,
            hasSelection,
            msSinceInteraction: Date.now() - lastInteraction.current,
        });
        if (action === 'banner') setAgentChanged(true);
        else refresh(action === 'silent');
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the write time only
    }, [lastWrite]);
    useLayoutEffect(() => {
        if (restoreScroll.current === null || state.phase !== 'text') return;
        const el = scroller();
        if (el) el.scrollTop = Math.min(restoreScroll.current, Math.max(0, el.scrollHeight - el.clientHeight));
        restoreScroll.current = null;
    }, [state]);

    useEffect(() => {
        let cancelled = false;
        const silent = reload.silent && stateRef.current.phase === 'text';
        if (!silent) {
            setState({ phase: 'loading', progress: null });
            setShowSource(false);
            setImgActual(false);
        }

        (async () => {
            if (kind === 'image' || kind === 'pdf' || kind === 'spreadsheet') {
                // Whole-file binary assembly from ≤512KB offset windows.
                const res = await assembleFsFile(
                    async (offset) => {
                        if (cancelled) return { ok: false as const, code: 'unknown', error: 'cancelled' };
                        return machineFsRead(machineId, path, {
                            maxBytes: FS_PREVIEW_CHUNK_BYTES,
                            allowBinary: true,
                            offset,
                        });
                    },
                    {
                        maxBytes: FS_PREVIEW_MAX_BYTES,
                        onProgress: (loaded, total) => {
                            if (!cancelled && total > 0) {
                                setState({ phase: 'loading', progress: Math.min(loaded / total, 1) });
                            }
                        },
                    },
                );
                if (cancelled) return;
                if (res.ok) {
                    setState({ phase: 'bytes', bytes: res.bytes, size: res.size });
                } else if (res.code === 'too-large') {
                    setState({ phase: 'too-large', size: res.size });
                } else if (res.code === 'needs-upgrade') {
                    setState({ phase: 'needs-upgrade', size: res.size });
                } else if (res.code === 'chunk-failed') {
                    setState({ phase: 'failed', failure: res.failure as FsFailure });
                } else {
                    setState({ phase: 'failed', failure: { ok: false, code: 'unknown', error: 'inconsistent read' } });
                }
                return;
            }

            // text / markdown: one capped window is the preview.
            const res = await machineFsRead(machineId, path, {});
            if (cancelled) return;
            if (!res.ok) {
                setState({ phase: 'failed', failure: res });
                return;
            }
            if (res.binary || res.content == null) {
                setState({ phase: 'binary', size: res.size });
                return;
            }
            setState({ phase: 'text', text: decodeUtf8(res.content), size: res.size, truncated: res.truncated });
        })().catch(() => { if (!cancelled) setState({ phase: 'failed', failure: { ok: false, code: 'unknown', error: 'read failed' } }); });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload.silent is read with the tick
    }, [machineId, path, kind, reload.tick]);

    // Blob URL lifecycle: created in an effect (not lazily during render — a
    // StrictMode double-render would leak one), revoked on replace/unmount.
    useEffect(() => {
        if (state.phase !== 'bytes' || kind === 'spreadsheet') return;
        const url = URL.createObjectURL(new Blob([state.bytes as BlobPart], { type: previewMimeOf(path) }));
        setBlobUrl(url);
        return () => {
            URL.revokeObjectURL(url);
            setBlobUrl(null);
        };
    }, [state, path]);

    const body = () => {
        switch (state.phase) {
            case 'loading':
                return (
                    <div className="fsb-center">
                        <Spinner size={16} />
                        {state.progress != null && (
                            <span className="fsb-caption mono">{Math.round(state.progress * 100)}%</span>
                        )}
                    </div>
                );
            case 'failed':
                return <div className="fsb-center">{fsFailureText(t, state.failure)}</div>;
            case 'too-large':
                return unpreviewable(t('fsBrowser.tooLarge', {
                    size: formatFsSize(state.size),
                    limit: formatFsSize(FS_PREVIEW_MAX_BYTES),
                }));
            case 'needs-upgrade':
                return (
                    <div className="fsb-center">
                        {t('fsBrowser.largeNeedsUpgrade', { size: formatFsSize(state.size) })}
                    </div>
                );
            case 'binary':
                return unpreviewable(zh ? '此类型无法预览' : 'This file type cannot be previewed');
            case 'bytes':
                if (kind === 'spreadsheet') return <SpreadsheetPreview bytes={state.bytes}/>;
                if (!blobUrl) return <div className="fsb-center"><Spinner size={16} /></div>;
                if (kind === 'pdf') {
                    return (
                        <div className="fsb-viewer-body fsb-viewer-body--pdf">
                            <iframe className="fsb-pdf" src={blobUrl} title={path} />
                        </div>
                    );
                }
                return (
                    <div className={`fsb-viewer-body fsb-viewer-body--img${imgActual ? ' is-actual' : ''}`}>
                        <img
                            className={`fsb-img${imgActual ? ' fsb-img--actual' : ''}`}
                            src={blobUrl}
                            alt={path}
                            title={imgActual ? t('fsBrowser.zoomToFit') : t('fsBrowser.zoomToActual')}
                            onClick={() => setImgActual((v) => !v)}
                        />
                        <span className="fsb-caption mono">{formatFsSize(state.size)}</span>
                    </div>
                );
            case 'text': {
                const truncNotice = state.truncated && (
                    <div className="fsb-notice">
                        {t('fsBrowser.fileTruncated', { size: formatFsSize(state.size) })}
                    </div>
                );
                if (kind === 'markdown' && !showSource) {
                    return (
                        <div className="fsb-viewer-body fsb-viewer-body--md">
                            {truncNotice}
                            <div className="fsb-md">
                                <Markdown text={state.text} trustContent />
                            </div>
                        </div>
                    );
                }
                if (kind === 'html' && !showSource) {
                    // Render the page itself, isolated in a sandboxed iframe.
                    // Crucially NO `allow-same-origin`: the file is written by the
                    // agent (or whoever it ran), so its scripts run in an opaque
                    // origin and cannot read this app's cookies, localStorage, or
                    // DOM. Machine-local relative asset paths do not resolve here
                    // (the frame has no origin), which is the expected limit of a
                    // single-file preview; the source toggle in the head shows the
                    // raw HTML. B-825: not srcDoc — that would inherit the app's CSP.
                    return (
                        <div className="fsb-viewer-body fsb-viewer-body--html">
                            {truncNotice}
                            <HtmlPreviewFrame html={state.text} title={path} />
                        </div>
                    );
                }
                return (
                    <div className="fsb-viewer-body fsb-viewer-body--code">
                        {truncNotice}
                        {/* file viewer has its own scroll surface — never collapse */}
                        <CodeView code={state.text} lang={langForPath(path)} showLineNumbers collapsible={false} />
                    </div>
                );
            }
        }
    };

    return (
        <div ref={rootRef} className={`fsb-viewer${fullscreen && !contained ? ' fsb--full' : ''}`}
            onScrollCapture={() => { lastInteraction.current = Date.now(); }}
            onPointerDownCapture={() => { lastInteraction.current = Date.now(); }}
            onWheelCapture={() => { lastInteraction.current = Date.now(); }}>
            <div className="fsb-viewer-head">
                {/* B-798 P2-3: 「返回」 is a ‹ before the path, not a third ✕ beside
                    the tab and panel close buttons. */}
                <button type="button" className="fsb-iconbtn fsb-viewer-close" onClick={onClose} aria-label={t('common.back')} title={t('common.back')}>
                    <ChevronLeft size={16} />
                </button>
                <span className="fsb-viewer-path" title={path}>{path}</span>
                <div className="fsb-viewer-actions">
                {(kind === 'markdown' || kind === 'html') && state.phase === 'text' && (
                    <button
                        type="button"
                        className={`fsb-iconbtn${showSource ? ' is-active' : ''}`}
                        onClick={() => setShowSource((v) => !v)}
                        aria-label={showSource ? t('fsBrowser.viewRendered') : t('fsBrowser.viewSource')}
                        title={showSource ? t('fsBrowser.viewRendered') : t('fsBrowser.viewSource')}
                    >
                        {showSource ? <Eye size={14} /> : <Code size={14} />}
                    </button>
                )}
                {state.phase === 'text' && !state.truncated && <CopyButton icon={ClipboardCopy} text={state.text} label={zh ? '复制文件内容' : 'Copy file contents'} showLabel className="fsb-iconbtn fsb-copy-content" size={14}/>}
                <button type="button" className="fsb-iconbtn" disabled={downloading} onClick={() => void download()} title={zh ? '下载文件' : 'Download file'} aria-label={zh ? '下载文件' : 'Download file'}>{downloading ? <Spinner size={14}/> : <Download size={14}/>}</button>
                {onPin && <button type="button" className="fsb-iconbtn" onClick={onPin} title={zh ? '固定到侧边栏' : 'Pin to side panel'} aria-label={zh ? '固定到侧边栏' : 'Pin to side panel'}><PanelRightOpen size={14}/></button>}
                <CopyButton text={path} label={t('fsBrowser.copyPath')} className="fsb-iconbtn" size={14} />
                <button
                    type="button"
                    className="fsb-iconbtn"
                    onClick={onToggleFullscreen}
                    aria-label={fullscreen ? t('fsBrowser.exitFullscreen') : t('fsBrowser.fullscreen')}
                    title={fullscreen ? t('fsBrowser.exitFullscreen') : t('fsBrowser.fullscreen')}
                >
                    {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                </div>
            </div>
            {headDownload.state.phase !== 'idle' && headDownload.state.phase !== 'reading' && (
                <div className="fsb-download-status"><DownloadFeedback state={headDownload.state} zh={zh} /></div>
            )}
            {agentChanged && (
                <div className="fsb-agent-changed" role="status">
                    <span className="fsb-agent-changed-text">{zh ? '文件已被 agent 修改' : 'The agent changed this file'}</span>
                    <button type="button" className="fsb-agent-changed-refresh" onClick={() => refresh(true)}>
                        <RefreshCw size={13} aria-hidden/>{zh ? '刷新' : 'Refresh'}
                    </button>
                    <button type="button" className="fsb-iconbtn" onClick={() => setAgentChanged(false)} aria-label={zh ? '关闭提示' : 'Dismiss'} title={zh ? '关闭提示' : 'Dismiss'}><X size={13}/></button>
                </div>
            )}
            {pushed && (
                <FileDownloadAction
                    variant="bar"
                    machineId={machineId}
                    path={path}
                    size={knownSize}
                    preloaded={preloaded}
                    // Wait for the preview read: it supplies the size (50 MiB gate) and,
                    // for images/PDFs, the bytes — no second read.
                    autoStart={pushed.auto && state.phase !== 'loading'}
                    onDismiss={() => setPushed(null)}
                />
            )}
            {body()}
        </div>
    );
}
