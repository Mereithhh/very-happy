/**
 * Programmatic open channel for the singleton FsPreviewOverlay — a window
 * event, the same pattern as CommandPalette / ClipboardHistoryPanel's
 * `openClipboardHistory()`.
 *
 * It lives in `sync/` rather than next to the component so the socket receiver
 * (`filePreviewPush.ts`) doesn't have to import from `screens/`.
 */

export interface FsPreviewRequest {
    machineId: string;
    /** Absolute path on that machine (already decrypted + validated). */
    path: string;
    /** 'diff' is a placeholder — the overlay renders a plain preview and says so. */
    mode: 'file' | 'diff';
}

const OPEN_EVENT = 'vh:fs-preview-open';

export function openFsPreview(request: FsPreviewRequest): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<FsPreviewRequest>(OPEN_EVENT, { detail: request }));
}

/** Subscribe (overlay side). Returns the unsubscribe function. */
export function onFsPreviewOpen(handler: (request: FsPreviewRequest) => void): () => void {
    const listener = (e: Event) => {
        const detail = (e as CustomEvent<FsPreviewRequest>).detail;
        if (detail && typeof detail.machineId === 'string' && typeof detail.path === 'string') {
            handler(detail);
        }
    };
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
}
