/**
 * Gate for the silent direct clipboard-write path (no imports on purpose —
 * unit-tested in a plain node environment).
 *
 * The page must be BOTH focused and visible: on macOS Chrome, the active tab
 * of a fully occluded window keeps `document.hasFocus() === true` while
 * `visibilityState === 'hidden'`, and in that state
 * `navigator.clipboard.writeText()` RESOLVES without actually writing to the
 * OS pasteboard (verified against prod 2026-08-12). A resolved write on a
 * hidden document cannot be trusted, so those pushes must take the visible
 * Modal/gesture path instead of silently "succeeding".
 */
export function canAttemptDirectWrite(doc: Pick<Document, 'visibilityState' | 'hasFocus'> | undefined): boolean {
    return !!doc && doc.visibilityState === 'visible' && doc.hasFocus();
}
