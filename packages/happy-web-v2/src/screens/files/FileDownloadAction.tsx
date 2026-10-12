/**
 * Download control for one machine file (B-562): the viewer's prominent bar
 * after an `open_preview(download: true)` push, the large button in the
 * "cannot preview" state, and the compact button on tool cards / history.
 *
 * Primary action uses the ink/canvas CTA (design contract: never accent).
 * After the bytes arrive it also renders a REAL `<a download>` link — the
 * gesture fallback for browsers that ignore the programmatic click (iOS).
 */
import { useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';
import { Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { formatFsSize } from './fsBrowseModel';
import { FILE_DOWNLOAD_MAX_BYTES, downloadFileName, tooLargeText } from './fileDownload';
import { useFileDownload, type FileDownloadState } from './useFileDownload';
import './filedownload.css';

export interface FileDownloadActionProps {
    machineId: string | null | undefined;
    path: string;
    /** Known size (from the preview read); shown on the button and used for the 50 MiB gate. */
    size?: number | null;
    variant: 'bar' | 'block' | 'inline';
    /** Already-assembled whole-file bytes to reuse instead of reading again. */
    preloaded?: () => Uint8Array | null;
    /** Start once on mount (pushed intent on desktop). Failure only shows inline. */
    autoStart?: boolean;
    onDismiss?: () => void;
    disabledReason?: string | null;
}

export function FileDownloadAction({ machineId, path, size = null, variant, preloaded, autoStart = false, onDismiss, disabledReason = null }: FileDownloadActionProps) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const { state, start, busy } = useFileDownload(machineId, path, zh);
    const name = downloadFileName(path);
    const tooLarge = size != null && size > FILE_DOWNLOAD_MAX_BYTES;
    const run = () => { if (!busy) void start(preloaded?.() ?? undefined); };

    const autoRan = useRef(false);
    useEffect(() => {
        if (!autoStart || autoRan.current || tooLarge || disabledReason) return;
        autoRan.current = true;
        run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoStart, tooLarge, disabledReason]);

    const sizeText = size != null ? formatFsSize(size) : '';
    const progress = state.phase === 'reading' && state.progress != null ? `${Math.round(state.progress * 100)}%` : '';
    const label = variant === 'inline'
        ? (zh ? '下载' : 'Download')
        : `${zh ? '下载' : 'Download'} ${name}${sizeText ? ` · ${sizeText}` : ''}`;

    return (
        <div className={`fdl fdl--${variant}`} data-phase={state.phase}>
            <div className="fdl-row">
                {tooLarge && variant !== 'inline' ? (
                    <p className="fdl-limit">{tooLargeText(size!, zh)}</p>
                ) : (
                    <button
                        type="button"
                        className={`fdl-btn${variant === 'inline' ? '' : ' fdl-btn--primary'}`}
                        onClick={run}
                        disabled={busy || !!disabledReason}
                        aria-busy={busy}
                        title={disabledReason ?? `${zh ? '下载' : 'Download'} ${name}`}
                    >
                        {busy ? <Spinner size={14} color="currentColor" /> : <Download size={variant === 'inline' ? 13 : 16} aria-hidden />}
                        <span className="fdl-label">{label}</span>
                        {progress && <span className="fdl-progress mono">{progress}</span>}
                    </button>
                )}
                {onDismiss && (
                    <button type="button" className="fdl-dismiss" onClick={onDismiss} aria-label={zh ? '关闭下载提示' : 'Dismiss download'} title={zh ? '关闭' : 'Dismiss'}>
                        <X size={14} />
                    </button>
                )}
            </div>
            {disabledReason && variant !== 'inline' && <p className="fdl-note">{disabledReason}</p>}
            <DownloadFeedback state={state} zh={zh} />
        </div>
    );
}

/** Error text, or — once bytes are ready — the real `<a download>` gesture fallback. */
export function DownloadFeedback({ state, zh }: { state: FileDownloadState; zh: boolean }) {
    if (state.phase === 'failed') return <p className="fdl-error" role="alert">{state.message}</p>;
    if (state.phase !== 'ready') return null;
    return (
        <p className="fdl-note" role="status">
            {zh ? '已开始下载。没有反应？' : 'Download started. Nothing happened? '}
            <a className="fdl-save" href={state.url} download={state.name}>
                {zh ? `点这里保存 ${state.name}` : `Save ${state.name}`}
            </a>
        </p>
    );
}
