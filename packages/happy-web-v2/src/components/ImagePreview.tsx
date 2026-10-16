import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, ImageOff, Minus, Plus, Scan, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui/Spinner';
import {
    BUTTON_MAX_SCALE, BUTTON_STEP, GESTURE_MAX_SCALE, clampScale, clampView, distance, doubleTapScale, fitScale as computeFitScale,
    fitView, gestureMinScale, isNearFit, midpoint, pastDeadZone, pinchView, wheelZoomFactor, zoomAt, type Point, type ZoomView,
} from './imagePreviewZoom';
import './imagePreview.css';

/** Keyboard pan step while zoomed (arrow keys replace the old scrollbars). */
const KEY_PAN = 48;
/** Double-tap window for touch (mouse uses the native dblclick). */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

type Gesture =
    | { kind: 'press' | 'pan'; id: number; start: Point; view: ZoomView; pointerType: string }
    | { kind: 'pinch'; startMid: Point; startDistance: number; view: ZoomView };

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
    // B-608: null = fit (follows canvas resizes); otherwise an explicit scale + pan.
    const [zoomView, setZoomView] = useState<ZoomView | null>(null);
    // Discrete changes (buttons, keys, double-click) ease; live gestures track 1:1.
    const [animate, setAnimate] = useState(false);
    const [panning, setPanning] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState(false);
    const loaded = image?.src === src ? image : null;
    const failed = errorSrc === src;
    const ready = !!loaded && !failed;
    // Canvas padding is 16px on every viewport, keeping fit calculations exact.
    const fitScale = loaded ? computeFitScale(loaded, viewport) : 1;
    // Re-clamped every render so a canvas resize can never strand the image off-screen.
    const view = loaded ? (zoomView ? clampView(zoomView, loaded, viewport) : fitView(loaded, viewport)) : { scale: 1, x: 0, y: 0 };
    const scale = view.scale;
    const minScale = Math.min(0.1, fitScale);
    const pannable = !!loaded && (loaded.width * scale > viewport.width - 32 + 0.5 || loaded.height * scale > viewport.height - 32 + 0.5);
    // Event handlers bound once (wheel is a native non-passive listener) read the latest geometry here.
    const geometryRef = useRef({ loaded, viewport, view, fitScale, ready: false });
    geometryRef.current = { loaded, viewport, view, fitScale, ready: !!loaded && errorSrc !== src };
    const pointersRef = useRef(new Map<number, Point>());
    const gestureRef = useRef<Gesture | null>(null);
    const lastTapRef = useRef<{ time: number; point: Point } | null>(null);
    const lastPointerTypeRef = useRef('mouse');
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
        setZoomView(null);
        setAnimate(false);
        setPanning(false);
        pointersRef.current.clear();
        gestureRef.current = null;
        lastTapRef.current = null;
        setErrorSrc(null);
        setDownloadError(false);
        setDownloading(false);
        downloadRef.current?.abort();
        downloadRef.current = null;
    }, [src]);

    useEffect(() => () => {
        downloadRef.current?.abort();
        downloadRef.current = null;
    }, []);

    /** Store a view; one that lands on fit becomes fit again so it tracks resizes. */
    const commitView = (next: ZoomView | null, eased: boolean) => {
        const { loaded: image, viewport: size, fitScale: fit } = geometryRef.current;
        setAnimate(eased);
        if (!next || !image || isNearFit(next.scale, fit)) { setZoomView(null); return; }
        setZoomView(clampView(next, image, size));
    };
    const canvasCenter = (): Point => ({ x: geometryRef.current.viewport.width / 2, y: geometryRef.current.viewport.height / 2 });
    /** Buttons and keys keep their pre-B-608 steps, anchored at the canvas centre. */
    const changeZoom = (next: number | null) => {
        if (next === null) { commitView(null, true); return; }
        commitView(zoomAt(geometryRef.current.view, next, canvasCenter()), true);
    };
    const zoomIn = () => { if (scale < BUTTON_MAX_SCALE) changeZoom(Math.min(BUTTON_MAX_SCALE, scale * BUTTON_STEP)); };
    const zoomOut = () => { if (scale > minScale) changeZoom(Math.max(minScale, scale / BUTTON_STEP)); };
    const toggleAt = (anchor: Point) => {
        const { view: current, fitScale: fit } = geometryRef.current;
        if (current.scale <= fit || isNearFit(current.scale, fit)) commitView(zoomAt(current, doubleTapScale(fit), anchor), true);
        else commitView(null, true);
    };
    const localPoint = (event: { clientX: number; clientY: number }): Point => {
        const rect = canvas?.getBoundingClientRect();
        return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    };

    // Wheel / trackpad pinch (ctrlKey wheel) zooms at the cursor. React's onWheel is
    // passive, so preventDefault (page scroll, browser pinch-zoom) needs a native listener.
    useEffect(() => {
        if (!canvas) return;
        const onWheel = (event: WheelEvent) => {
            const { ready: isReady, view: current, fitScale: fit, loaded: image, viewport: size } = geometryRef.current;
            if (!isReady || !image) return;
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            const next = clampScale(current.scale * wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey), gestureMinScale(fit, current.scale), GESTURE_MAX_SCALE);
            if (next === current.scale) return;
            const zoomed = clampView(zoomAt(current, next, anchor), image, size);
            setAnimate(false);
            setZoomView(isNearFit(next, fit) ? null : zoomed);
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', onWheel);
    }, [canvas]);

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        lastPointerTypeRef.current = event.pointerType;
        if (!geometryRef.current.ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const point = localPoint(event);
        const pointers = pointersRef.current;
        pointers.set(event.pointerId, point);
        if (pointers.size === 1) {
            gestureRef.current = { kind: 'press', id: event.pointerId, start: point, view: geometryRef.current.view, pointerType: event.pointerType };
        } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            gestureRef.current = { kind: 'pinch', startMid: midpoint(a, b), startDistance: distance(a, b), view: geometryRef.current.view };
            lastTapRef.current = null;
            setPanning(false);
            for (const id of pointers.keys()) if (!event.currentTarget.hasPointerCapture(id)) try { event.currentTarget.setPointerCapture(id); } catch { /* pointer already gone */ }
        }
    };
    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const pointers = pointersRef.current;
        const gesture = gestureRef.current;
        if (!gesture || !pointers.has(event.pointerId)) return;
        const point = localPoint(event);
        pointers.set(event.pointerId, point);
        const { loaded: image, viewport: size, fitScale: fit } = geometryRef.current;
        if (!image) return;
        if (gesture.kind === 'pinch') {
            if (pointers.size < 2) return;
            const [a, b] = [...pointers.values()];
            const next = clampView(pinchView(gesture.view, gesture.startMid, gesture.startDistance, midpoint(a, b), distance(a, b), gestureMinScale(fit, gesture.view.scale)), image, size);
            setAnimate(false);
            setZoomView(isNearFit(next.scale, fit) ? null : next);
            return;
        }
        if (gesture.id !== event.pointerId) return;
        if (gesture.kind === 'press') {
            if (!pastDeadZone(gesture.start, point)) return;
            gestureRef.current = { ...gesture, kind: 'pan' };
            lastTapRef.current = null;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
            setPanning(true);
        }
        const next = { scale: gesture.view.scale, x: gesture.view.x + point.x - gesture.start.x, y: gesture.view.y + point.y - gesture.start.y };
        // A fit-sized image has nothing to pan: clamping recentres it, and keeping null keeps it in fit mode.
        if (isNearFit(next.scale, fit)) return;
        setAnimate(false);
        setZoomView(clampView(next, image, size));
    };
    const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
        const pointers = pointersRef.current;
        if (!pointers.delete(event.pointerId)) return;
        const gesture = gestureRef.current;
        if (gesture?.kind === 'pinch') {
            // One finger left: continue as a pan from where it is, without a jump.
            const rest = [...pointers.entries()][0];
            gestureRef.current = rest ? { kind: 'pan', id: rest[0], start: rest[1], view: geometryRef.current.view, pointerType: 'touch' } : null;
            return;
        }
        if (pointers.size > 0) return;
        gestureRef.current = null;
        setPanning(false);
        if (cancelled || gesture?.kind !== 'press' || gesture.pointerType === 'mouse') return;
        // Touch/pen double-tap; mouse uses the native dblclick below.
        const point = localPoint(event);
        const last = lastTapRef.current;
        if (last && event.timeStamp - last.time < DOUBLE_TAP_MS && distance(last.point, point) < DOUBLE_TAP_SLOP) {
            lastTapRef.current = null;
            toggleAt(point);
        } else {
            lastTapRef.current = { time: event.timeStamp, point };
        }
    };
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!ready || event.ctrlKey || event.metaKey || event.altKey) return;
        const pan = (dx: number, dy: number) => {
            if (!pannable) return false;
            commitView({ scale, x: view.x + dx, y: view.y + dy }, true);
            return true;
        };
        let handled = true;
        switch (event.key) {
            case '+': case '=': zoomIn(); break;
            case '-': case '_': zoomOut(); break;
            case '0': changeZoom(null); break;
            case 'ArrowLeft': handled = pan(KEY_PAN, 0); break;
            case 'ArrowRight': handled = pan(-KEY_PAN, 0); break;
            case 'ArrowUp': handled = pan(0, KEY_PAN); break;
            case 'ArrowDown': handled = pan(0, -KEY_PAN); break;
            default: handled = false;
        }
        if (handled) event.preventDefault();
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
                onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={onKeyDown}>
                <header className="image-preview-header">
                    <Dialog.Title className="image-preview-title" title={title}>{title}</Dialog.Title>
                    <button type="button" className="image-preview-button" onClick={() => { void download(); }} disabled={downloading}
                        title={downloading ? labels.downloading : labels.download} aria-label={downloading ? labels.downloading : labels.download}>
                        {downloading ? <Spinner size={16} /> : <Download size={18} />}
                    </button>
                    <Dialog.Close asChild><button type="button" className="image-preview-button" title={labels.close} aria-label={labels.close}><X size={19} /></button></Dialog.Close>
                </header>
                <div ref={setCanvas} className={`image-preview-canvas${ready && pannable ? ' is-pannable' : ''}${panning ? ' is-panning' : ''}`} aria-busy={!ready && !failed}
                    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                    onPointerUp={event => endPointer(event, false)} onPointerCancel={event => endPointer(event, true)}
                    onDoubleClick={event => { if (ready && lastPointerTypeRef.current === 'mouse') toggleAt(localPoint(event)); }}>
                        <img key={`${src}:${attempt}`} className={`image-preview-image${animate ? ' is-animating' : ''}`} src={src} alt={title} draggable={false}
                            style={{ width: loaded ? loaded.width : 1, height: loaded ? loaded.height : 1, transform: `translate(${view.x}px, ${view.y}px) scale(${scale})`, visibility: ready ? 'visible' : 'hidden' }}
                            onLoad={event => {
                                const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                                if (srcRef.current !== src) return;
                                if (width > 0 && height > 0) { setImage({ src, width, height }); setErrorSrc(null); }
                                else setErrorSrc(src);
                            }} onError={() => { if (srcRef.current === src) setErrorSrc(src); }} />
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
                            aria-label={labels.zoomOut} title={labels.zoomOut} onClick={zoomOut}><Minus size={17} /></button>
                        <output className="image-preview-scale" aria-label={labels.zoom}>{ready ? scaleLabel : '—'}</output>
                        <button type="button" className="image-preview-button" disabled={!ready || scale >= BUTTON_MAX_SCALE}
                            aria-label={labels.zoomIn} title={labels.zoomIn} onClick={zoomIn}><Plus size={17} /></button>
                        <button type="button" className="image-preview-button image-preview-button--fit" disabled={!ready} aria-pressed={zoomView === null}
                            aria-label={labels.fitLabel} title={labels.fitLabel} onClick={() => changeZoom(null)}><Scan size={16} /><span>{labels.fit}</span></button>
                        <button type="button" className="image-preview-button image-preview-button--original" disabled={!ready} aria-pressed={zoomView !== null && Math.abs(scale - 1) < 1e-6}
                            aria-label={labels.original} title={labels.original} onClick={() => changeZoom(1)}>100%</button>
                    </div>
                    {loaded && <span className="image-preview-dimensions" aria-label={labels.dimensions}>{loaded.width} × {loaded.height}</span>}
                </footer>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
