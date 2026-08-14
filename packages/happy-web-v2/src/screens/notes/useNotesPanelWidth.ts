/**
 * useNotesPanelWidth — drag-to-resize controller for the notes dock. Same
 * mechanics as useFilesPanelWidth (right-anchored; window listeners bound
 * once; body.vh-col-resizing during the drag), persisted in
 * localSettings.notesPanelWidth.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocalSettingMutable } from '@/sync/storage';
import { resolveNotesPanelWidth, notesPanelWidthFromPointer } from './notesPanelWidth';

export function useNotesPanelWidth() {
    const [stored, setStored] = useLocalSettingMutable('notesPanelWidth');
    const width = resolveNotesPanelWidth(stored, typeof window !== 'undefined' ? window.innerWidth : 0);

    const draggingRef = useRef(false);
    // Right edge captured at drag start — the dock is right-anchored, so only
    // the LEFT edge moves with the pointer.
    const edgeRef = useRef(0);

    const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const row = (e.currentTarget as HTMLElement).parentElement;
        edgeRef.current = row ? row.getBoundingClientRect().right : window.innerWidth;
        draggingRef.current = true;
        document.body.classList.add('vh-col-resizing');
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!draggingRef.current) return;
            setStored(notesPanelWidthFromPointer(e.clientX, edgeRef.current, window.innerWidth));
        };
        const endDrag = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            document.body.classList.remove('vh-col-resizing');
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
