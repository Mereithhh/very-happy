/**
 * useFilesPanelWidth — drag-to-resize controller for the right-hand files
 * panel, shared by both hosts (session FilesPanel + terminal file browser).
 * Same mechanics as AppLayout's sidebar drag (mousemove/mouseup on window,
 * body.vh-col-resizing during the drag), but right-anchored and persisted in
 * localSettings.filesPanelWidth so the two hosts share one width.
 *
 * onDragStart/onDragEnd exist for the terminal host's FitAddon throttle:
 * per-mousemove refits would run the whole fit → resize-RPC → tmux-reflow
 * chain every frame (the historical judder), so the terminal suppresses
 * refits during the drag and runs exactly one on release.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocalSettingMutable } from '@/sync/storage';
import { resolveFilesPanelWidth, filesPanelWidthFromPointer } from './filesPanelWidth';

export function useFilesPanelWidth(opts?: { onDragStart?: () => void; onDragEnd?: () => void }) {
    const [stored, setStored] = useLocalSettingMutable('filesPanelWidth');
    const width = resolveFilesPanelWidth(stored, typeof window !== 'undefined' ? window.innerWidth : 0);

    const draggingRef = useRef(false);
    // The panel's right edge, captured once at drag start (it's anchored right,
    // so it doesn't move during the drag; the pointer only moves the LEFT edge).
    const edgeRef = useRef(0);
    // Latest callbacks via refs so the window listeners bind once.
    const optsRef = useRef(opts);
    optsRef.current = opts;

    const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const row = (e.currentTarget as HTMLElement).parentElement;
        edgeRef.current = row ? row.getBoundingClientRect().right : window.innerWidth;
        draggingRef.current = true;
        document.body.classList.add('vh-col-resizing');
        optsRef.current?.onDragStart?.();
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!draggingRef.current) return;
            setStored(filesPanelWidthFromPointer(e.clientX, edgeRef.current, window.innerWidth));
        };
        const endDrag = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            document.body.classList.remove('vh-col-resizing');
            optsRef.current?.onDragEnd?.();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', endDrag);
        window.addEventListener('blur', endDrag);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', endDrag);
            window.removeEventListener('blur', endDrag);
            endDrag(); // unmount mid-drag must not strand the body class
        };
    }, [setStored]);

    return { width, onHandleMouseDown };
}
