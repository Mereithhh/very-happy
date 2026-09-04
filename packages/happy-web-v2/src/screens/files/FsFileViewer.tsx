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
import { useEffect, useState } from 'react';
import { Code, Eye, Maximize2, Minimize2, X } from 'lucide-react';
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
import { fsFailureText } from './fsFailureText';

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

export function FsFileViewer({ machineId, path, onClose, fullscreen, onToggleFullscreen }: {
    machineId: string;
    path: string;
    onClose: () => void;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
}) {
    const { t } = useTranslation();
    const kind = previewKindOf(path);
    const [state, setState] = useState<ViewerState>({ phase: 'loading', progress: null });
    const [mdSource, setMdSource] = useState(false);
    const [imgActual, setImgActual] = useState(false);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setState({ phase: 'loading', progress: null });
        setMdSource(false);
        setImgActual(false);

        (async () => {
            if (kind === 'image' || kind === 'pdf') {
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
        })();

        return () => {
            cancelled = true;
        };
    }, [machineId, path, kind]);

    // Blob URL lifecycle: created in an effect (not lazily during render — a
    // StrictMode double-render would leak one), revoked on replace/unmount.
    useEffect(() => {
        if (state.phase !== 'bytes') return;
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
                return (
                    <div className="fsb-center">
                        {t('fsBrowser.tooLarge', {
                            size: formatFsSize(state.size),
                            limit: formatFsSize(FS_PREVIEW_MAX_BYTES),
                        })}
                    </div>
                );
            case 'needs-upgrade':
                return (
                    <div className="fsb-center">
                        {t('fsBrowser.largeNeedsUpgrade', { size: formatFsSize(state.size) })}
                    </div>
                );
            case 'binary':
                return (
                    <div className="fsb-center">
                        {t('fsBrowser.binaryFile', { size: formatFsSize(state.size) })}
                    </div>
                );
            case 'bytes':
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
                if (kind === 'markdown' && !mdSource) {
                    return (
                        <div className="fsb-viewer-body fsb-viewer-body--md">
                            {truncNotice}
                            <div className="fsb-md">
                                <Markdown text={state.text} trustContent />
                            </div>
                        </div>
                    );
                }
                return (
                    <div className="fsb-viewer-body">
                        {truncNotice}
                        {/* file viewer has its own scroll surface — never collapse */}
                        <CodeView code={state.text} lang={langForPath(path)} collapsible={false} />
                    </div>
                );
            }
        }
    };

    return (
        <div className={`fsb-viewer${fullscreen ? ' fsb--full' : ''}`}>
            <div className="fsb-viewer-head">
                <span className="fsb-viewer-path" title={path}>{path}</span>
                {kind === 'markdown' && state.phase === 'text' && (
                    <button
                        type="button"
                        className={`fsb-iconbtn${mdSource ? ' is-active' : ''}`}
                        onClick={() => setMdSource((v) => !v)}
                        aria-label={mdSource ? t('fsBrowser.viewRendered') : t('fsBrowser.viewSource')}
                        title={mdSource ? t('fsBrowser.viewRendered') : t('fsBrowser.viewSource')}
                    >
                        {mdSource ? <Eye size={14} /> : <Code size={14} />}
                    </button>
                )}
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
                <button type="button" className="fsb-iconbtn" onClick={onClose} aria-label={t('common.back')} title={t('common.back')}>
                    <X size={15} />
                </button>
            </div>
            {body()}
        </div>
    );
}
