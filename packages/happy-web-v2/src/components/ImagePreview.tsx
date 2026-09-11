import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, ImageOff, Minus, Plus, Scan, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui/Spinner';
import './imagePreview.css';

const copy = {
    en: { title: 'Image preview', loading: 'Loading image…', failed: 'Could not load this image.', retry: 'Retry',
        close: 'Close image preview', download: 'Download image', downloading: 'Downloading image…', downloadFailed: 'Download failed. Try again.',
        zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoom: 'Zoom', fit: 'Fit', fitLabel: 'Fit image to view', original: 'Original size', dimensions: 'Image dimensions' },
    zh: { title: '图片预览', loading: '正在加载图片…', failed: '图片加载失败。', retry: '重试',
        close: '关闭图片预览', download: '下载图片', downloading: '正在下载图片…', downloadFailed: '下载失败，请重试。',
        zoomIn: '放大', zoomOut: '缩小', zoom: '缩放比例', fit: '适应', fitLabel: '适应窗口', original: '原始尺寸', dimensions: '图片尺寸' },
};

/** A user-opened image stays in the workspace; no new tab or data-URL navigation. */
export function ImagePreview({ src, name, onClose }: { src: string; name?: string; onClose: () => void }) {
    const { lang } = useTranslation();
    const labels = lang?.startsWith('zh') ? copy.zh : copy.en;
    const [returnFocus] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
    const downloadRef = useRef<AbortController | null>(null);
    const srcRef = useRef(src);
    srcRef.current = src;
    const [image, setImage] = useState<{ src: string; width: number; height: number } | null>(null);
    const [errorSrc, setErrorSrc] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const [zoom, setZoom] = useState<number | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState(false);
    const loaded = image?.src === src ? image : null;
    const failed = errorSrc === src;
    const ready = !!loaded && !failed;
    // Canvas padding is 16px on every viewport, keeping fit calculations exact.
    const fitScale = loaded && viewport.width > 0 && viewport.height > 0
        ? Math.min(1, Math.max(1, viewport.width - 32) / loaded.width, Math.max(1, viewport.height - 32) / loaded.height)
        : 1;
    const scale = zoom ?? fitScale;
    const minScale = Math.min(0.1, fitScale);
    const scaleLabel = `${Number((scale * 100).toFixed(scale < 0.01 ? 1 : 0))}%`;
    const title = name?.trim() || labels.title;

    useLayoutEffect(() => {
        if (!canvas) return;
        const measure = () => setViewport(current => {
            const next = { width: canvas.clientWidth, height: canvas.clientHeight };
            return current.width === next.width && current.height === next.height ? current : next;
        });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [canvas]);

    useEffect(() => {
        setZoom(null);
        setErrorSrc(null);
        setDownloadError(false);
        setDownloading(false);
        downloadRef.current?.abort();
        downloadRef.current = null;
        canvas?.scrollTo({ left: 0, top: 0 });
    }, [src, canvas]);

    useEffect(() => () => {
        downloadRef.current?.abort();
        downloadRef.current = null;
    }, []);

    const changeZoom = (next: number | null) => {
        setZoom(next);
        // Reset when changing scale so a previous off-screen corner cannot hide the image.
        canvas?.scrollTo({ left: 0, top: 0 });
    };
    const download = async () => {
        if (downloadRef.current) return;
        const controller = new AbortController();
        downloadRef.current = controller;
        setDownloading(true);
        setDownloadError(false);
        try {
            const response = await fetch(src, { signal: controller.signal });
            if (!response.ok) throw new Error('download-failed');
            const blob = await response.blob();
            if (controller.signal.aborted || srcRef.current !== src) return;
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = name?.split(/[\\/]/).pop()?.trim() || 'image';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            // Safari resolves the URL after the click; do not revoke it on dialog close.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch {
            if (!controller.signal.aborted && srcRef.current === src) setDownloadError(true);
        } finally {
            if (downloadRef.current === controller) {
                downloadRef.current = null;
                setDownloading(false);
            }
        }
    };

    return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="image-preview-overlay" />
            <Dialog.Content ref={contentRef} className="image-preview" aria-modal="true" aria-describedby={undefined}
                onOpenAutoFocus={event => { event.preventDefault(); contentRef.current?.focus(); }}
                onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }}
                onEscapeKeyDown={event => event.stopPropagation()}>
                <header className="image-preview-header">
                    <Dialog.Title className="image-preview-title" title={title}>{title}</Dialog.Title>
                    <button type="button" className="image-preview-button" onClick={() => { void download(); }} disabled={downloading}
                        title={downloading ? labels.downloading : labels.download} aria-label={downloading ? labels.downloading : labels.download}>
                        {downloading ? <Spinner size={16} /> : <Download size={18} />}
                    </button>
                    <Dialog.Close asChild><button type="button" className="image-preview-button" title={labels.close} aria-label={labels.close}><X size={19} /></button></Dialog.Close>
                </header>
                <div ref={setCanvas} className="image-preview-canvas" aria-busy={!ready && !failed}>
                    <div className="image-preview-surface">
                        <img key={`${src}:${attempt}`} className="image-preview-image" src={src} alt={title} draggable={false}
                            style={{ width: loaded ? loaded.width * scale : 1, height: loaded ? loaded.height * scale : 1, visibility: ready ? 'visible' : 'hidden' }}
                            onLoad={event => {
                                const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                                if (srcRef.current !== src) return;
                                if (width > 0 && height > 0) { setImage({ src, width, height }); setErrorSrc(null); }
                                else setErrorSrc(src);
                            }} onError={() => { if (srcRef.current === src) setErrorSrc(src); }} />
                    </div>
                    {!ready && <div className="image-preview-status" role={failed ? 'alert' : 'status'}>
                        {failed ? <ImageOff size={24} aria-hidden /> : <Spinner size={20} />}
                        <span>{failed ? labels.failed : labels.loading}</span>
                        {failed && <button type="button" className="image-preview-retry" onClick={() => { setErrorSrc(null); setImage(null); setAttempt(value => value + 1); }}>{labels.retry}</button>}
                    </div>}
                </div>
                {downloadError && <div className="image-preview-error" role="alert">{labels.downloadFailed}</div>}
                <footer className="image-preview-footer">
                    <div className="image-preview-controls" role="group" aria-label={labels.zoom}>
                        <button type="button" className="image-preview-button" disabled={!ready || scale <= minScale}
                            aria-label={labels.zoomOut} title={labels.zoomOut} onClick={() => changeZoom(Math.max(minScale, scale / 1.25))}><Minus size={17} /></button>
                        <output className="image-preview-scale" aria-label={labels.zoom}>{ready ? scaleLabel : '—'}</output>
                        <button type="button" className="image-preview-button" disabled={!ready || scale >= 4}
                            aria-label={labels.zoomIn} title={labels.zoomIn} onClick={() => changeZoom(Math.min(4, scale * 1.25))}><Plus size={17} /></button>
                        <button type="button" className="image-preview-button image-preview-button--fit" disabled={!ready} aria-pressed={zoom === null}
                            aria-label={labels.fitLabel} title={labels.fitLabel} onClick={() => changeZoom(null)}><Scan size={16} /><span>{labels.fit}</span></button>
                        <button type="button" className="image-preview-button image-preview-button--original" disabled={!ready} aria-pressed={zoom === 1}
                            aria-label={labels.original} title={labels.original} onClick={() => changeZoom(1)}>100%</button>
                    </div>
                    {loaded && <span className="image-preview-dimensions" aria-label={labels.dimensions}>{loaded.width} × {loaded.height}</span>}
                </footer>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
