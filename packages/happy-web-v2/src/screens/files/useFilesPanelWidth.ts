/**
 * useFilesPanelWidth — drag-to-resize controller for the right-hand files
 * panel, shared by both hosts (session FilesPanel + terminal file browser).
 * Right-anchored and persisted in localSettings.filesPanelWidth so the two
 * hosts share one width; body.vh-col-resizing during a drag (cursor, no text
 * selection, and the iframe pointer shield in layout.css).
 *
 * B-609: `handleProps` is the pointer-event separator (mouse/pen/touch with
 * pointer capture, 4px dead zone, Escape cancels back to the start width,
 * double-click resets to the responsive default, keyboard Arrow/Home/End,
 * role=separator + aria-value*). With `onCollapse`, releasing a drag that went
 * below FILES_PANEL_COLLAPSE_THRESHOLD closes the panel and leaves the stored
 * width untouched, so reopening restores the last real width. A drag is only
 * persisted on release (live width meanwhile), which is what makes Escape and
 * collapse exact.
 *
 * `onHandleMouseDown` is the pre-B-609 mouse entry, kept for the terminal
 * host; it shares the same drag core (no collapse there).
 *
 * onDragStart/onDragEnd exist for the terminal host's FitAddon throttle:
 * per-move refits would run the whole fit → resize-RPC → tmux-reflow chain
 * every frame (the historical judder), so the terminal suppresses refits
 * during the drag and runs exactly one on release.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSettingMutable } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import {
    FILES_PANEL_MIN, filesPanelKeyboardWidth, filesPanelMaxWidth, filesPanelPastDeadZone, filesPanelWidthFromPointer,
    resolveFilesPanelWidth, shouldCollapseFilesPanel,
} from './filesPanelWidth';

type Options = { onDragStart?: () => void; onDragEnd?: () => void; onCollapse?: () => void };
type Drag = {
    pointerId: number | null; startX: number; startY: number; edge: number;
    active: boolean; width: number; collapse: boolean;
};

const copy = {
    en: { label: 'Resize workspace panel', hint: 'Drag to resize · double-click to reset' },
    zh: { label: '调整工作区面板宽度', hint: '拖动调整宽度 · 双击恢复默认' },
};

export function useFilesPanelWidth(opts?: Options) {
    const [stored, setStored] = useLocalSettingMutable('filesPanelWidth');
    const { lang } = useTranslation();
    const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 0);
    useEffect(() => {
        const resize = () => setViewportWidth(window.innerWidth);
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);
    const restingWidth = resolveFilesPanelWidth(stored, viewportWidth);
    // Live drag state; null when idle. Persisted only on release.
    const [live, setLive] = useState<{ width: number; collapse: boolean } | null>(null);
    const width = live?.width ?? restingWidth;

    const dragRef = useRef<Drag | null>(null);
    // Latest callbacks / values via refs so the window listeners bind once.
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const setStoredRef = useRef(setStored);
    setStoredRef.current = setStored;

    const begin = useCallback((handle: HTMLElement, clientX: number, clientY: number, pointerId: number | null) => {
        // The panel's right edge, captured once: it is anchored right, so it
        // doesn't move during the drag; the pointer only moves the LEFT edge.
        const row = handle.parentElement;
        dragRef.current = {
            pointerId, startX: clientX, startY: clientY,
            edge: row ? row.getBoundingClientRect().right : window.innerWidth,
            active: false, width: 0, collapse: false,
        };
    }, []);

    const update = useCallback((clientX: number, clientY: number) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (!drag.active) {
            if (!filesPanelPastDeadZone(drag.startX, drag.startY, clientX, clientY)) return;
            drag.active = true;
            document.body.classList.add('vh-col-resizing');
            optsRef.current?.onDragStart?.();
        }
        drag.width = filesPanelWidthFromPointer(clientX, drag.edge, window.innerWidth);
        drag.collapse = shouldCollapseFilesPanel(drag.edge - clientX, !!optsRef.current?.onCollapse);
        setLive({ width: drag.width, collapse: drag.collapse });
    }, []);

    /** commit: 'release' persists or collapses; 'keep' persists, never collapses; 'cancel' restores the start width. */
    const finish = useCallback((mode: 'release' | 'keep' | 'cancel') => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        setLive(null);
        if (!drag.active) return;
        document.body.classList.remove('vh-col-resizing');
        if (mode === 'release' && drag.collapse) optsRef.current?.onCollapse?.();
        else if (mode !== 'cancel') setStoredRef.current(drag.width);
        optsRef.current?.onDragEnd?.();
    }, []);

    useEffect(() => {
        // Legacy mouse path (terminal host) moves through window listeners.
        const onMove = (e: MouseEvent) => { if (dragRef.current?.pointerId === null) update(e.clientX, e.clientY); };
        const onUp = () => { if (dragRef.current?.pointerId === null) finish('release'); };
        // Escape during an active drag restores the start width. Capture phase
        // + stopPropagation so it doesn't also close a dialog or panel.
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !dragRef.current?.active) return;
            e.preventDefault();
            e.stopPropagation();
            finish('cancel');
        };
        const onBlur = () => finish('keep');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', onBlur);
            // Unmount mid-drag must not strand the body class.
            const drag = dragRef.current;
            dragRef.current = null;
            if (drag?.active) document.body.classList.remove('vh-col-resizing');
        };
    }, [update, finish]);

    const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        begin(e.currentTarget as HTMLElement, e.clientX, e.clientY, null);
    }, [begin]);

    const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // No text selection / native touch scrolling while pressing the handle.
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        begin(e.currentTarget, e.clientX, e.clientY, e.pointerId);
    };
    const own = (e: React.PointerEvent) => dragRef.current !== null && dragRef.current.pointerId === e.pointerId;
    const labels = lang?.startsWith('zh') ? copy.zh : copy.en;
    const maxWidth = filesPanelMaxWidth(viewportWidth);

    const handleProps = {
        role: 'separator' as const,
        'aria-orientation': 'vertical' as const,
        'aria-label': labels.label,
        'aria-valuenow': Math.round(width),
        'aria-valuemin': FILES_PANEL_MIN,
        'aria-valuemax': maxWidth,
        title: labels.hint,
        tabIndex: 0,
        'data-collapse': live?.collapse ? 'armed' : undefined,
        onPointerDown,
        onPointerMove: (e: React.PointerEvent<HTMLElement>) => { if (own(e)) update(e.clientX, e.clientY); },
        onPointerUp: (e: React.PointerEvent<HTMLElement>) => { if (own(e)) finish('release'); },
        onPointerCancel: (e: React.PointerEvent<HTMLElement>) => { if (own(e)) finish('cancel'); },
        onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => { if (own(e)) finish('cancel'); },
        onDoubleClick: (e: React.MouseEvent<HTMLElement>) => {
            e.preventDefault();
            finish('cancel');
            setStored(null); // null = responsive default, persisted
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            const next = filesPanelKeyboardWidth(width, e.key, e.shiftKey, viewportWidth);
            if (next === null) return;
            e.preventDefault();
            setStored(next);
        },
    };

    return { width, collapseArmed: !!live?.collapse, dragging: live !== null, handleProps, onHandleMouseDown };
}
