/**
 * Terminal path links + gutter-free copy (B-574) — the xterm/DOM half.
 * Spec: specs/2026-10-terminal-paths-and-quick-open.md D1/D3. Pure logic
 * lives in ./termPathLinks and ./termSelectionGutter.
 *
 * WebTerminalScreen is a conflict hot zone: it calls this hook once (AFTER
 * its terminal effect, so the xterm instance exists) and forwards one line
 * from its touchend handler. Everything else lives here.
 *
 * Gestures:
 *  - desktop: ⌘-click (Ctrl-click off Mac) opens; the underline/hand cursor
 *    only shows while that modifier is held, so plain clicks look and act
 *    exactly as before (focus / select / copy-on-select).
 *  - touch: a short still tap exactly on a path opens it and is consumed
 *    (no keyboard, no compat mouse events). Long press, select mode and any
 *    live selection pass through untouched — native long-press copy is the
 *    reason the DOM renderer exists (铁律 9).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ILink, Terminal } from '@xterm/xterm';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui/Toast';
import { isPathOpenClick, isPathTapGesture, pathAtCell, pathLinksOnRow, resolveTerminalPath, type PathCandidate } from './termPathLinks';
import { normalizeTerminalDomText, stripTerminalSelectionGutter } from './termSelectionGutter';
import { openVerifiedFile, revealPreviewLine } from './termPathOpen';
import type { TerminalRenderer } from './renderer';
import './termPathLinks.css';

/**
 * Private-API, best effort (same stance as remeasureFont in xtermRenderer):
 * make the Linkifier re-ask providers on the next mouse move. A renamed field
 * only costs the stale-cache edge case, never an error.
 */
function invalidateLinkCache(term: Terminal): void {
    try {
        const linkifier = (term as unknown as { _core?: { linkifier?: { _activeLine?: number } } })._core?.linkifier;
        if (linkifier && typeof linkifier._activeLine === 'number') linkifier._activeLine = -1;
    } catch { /* best-effort */ }
}

function hasDomSelection(): boolean {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

/** Text a copy event inside this terminal should carry, or null = don't touch it. */
function terminalCopyText(term: Terminal, host: HTMLElement, target: EventTarget | null): string | null {
    if (term.hasSelection() && target instanceof Node && host.contains(target)) {
        const raw = term.getSelection();
        const stripped = stripTerminalSelectionGutter(raw);
        return stripped === raw ? null : stripped; // unchanged → leave it to xterm
    }
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const rows = host.querySelector('.xterm-rows');
    const range = sel.getRangeAt(0);
    if (!rows || !rows.contains(range.startContainer) || !rows.contains(range.endContainer)) return null;
    const raw = sel.toString();
    const cleaned = stripTerminalSelectionGutter(normalizeTerminalDomText(raw));
    return cleaned === raw ? null : cleaned;
}

export function useTermPathLinks({ termRef, hostRef, machineId, cwd, surfaceKey, isMac, coarsePointer, selectModeRef }: {
    termRef: React.RefObject<TerminalRenderer | null>;
    hostRef: React.RefObject<HTMLElement | null>;
    machineId: string | undefined;
    cwd: string | undefined;
    /** Identity of the live xterm instance (termSearchSurfaceKey) — re-registers on rebuild. */
    surfaceKey: string;
    isMac: boolean;
    coarsePointer: boolean;
    selectModeRef: React.RefObject<boolean>;
}) {
    const { t } = useTranslation();
    const live = useRef({ machineId, cwd, t });
    live.current = { machineId, cwd, t };

    const openCandidate = useCallback(async (c: PathCandidate) => {
        const { machineId: mid, cwd: dir, t: tr } = live.current;
        if (!mid) return;
        const abs = resolveTerminalPath(c.pathText, dir);
        if (!abs) {
            toast.show(tr('terminalPaths.noCwd', { path: c.pathText }), 'info');
            return;
        }
        const outcome = await openVerifiedFile({ machineId: mid, path: abs });
        if (outcome === 'missing') toast.show(tr('terminalPaths.notFound', { path: abs }), 'info');
        else if (outcome === 'directory') toast.show(tr('terminalPaths.isDirectory', { path: abs }), 'info');
        else if (c.line) revealPreviewLine(abs, c.line);
    }, []);

    const touchStartAt = useRef(0);

    useEffect(() => {
        const term = termRef.current?.raw;
        const host = hostRef.current;
        if (!term || !host) return;

        // ── desktop links ──
        let modifier = false;
        let hovered: ILink | null = null;
        const setModifier = (on: boolean) => {
            if (on === modifier) return;
            modifier = on;
            if (hovered?.decorations) {
                hovered.decorations.underline = on;
                hovered.decorations.pointerCursor = on;
            }
        };
        const onMouseMove = (e: MouseEvent) => setModifier(isPathOpenClick(e, isMac));
        const onKey = (e: KeyboardEvent) => setModifier(isPathOpenClick(e, isMac));
        const onBlur = () => setModifier(false);
        const provider = term.registerLinkProvider({
            provideLinks(y, callback) {
                const links: ILink[] = pathLinksOnRow(term.buffer.active, y - 1).map(({ candidate, range }) => {
                    const link: ILink = {
                        range,
                        text: candidate.pathText,
                        decorations: { underline: modifier, pointerCursor: modifier },
                        activate: (event) => {
                            if (!isPathOpenClick(event, isMac)) return;
                            event.preventDefault();
                            void openCandidate(candidate);
                        },
                        hover: () => { hovered = link; },
                        leave: () => { if (hovered === link) hovered = null; },
                    };
                    return link;
                });
                callback(links.length ? links : undefined);
            },
        });
        // xterm 5.5's Linkifier caches each line's provider replies until the
        // mouse changes LINE (or the terminal resizes) — not when the line's
        // text changes. A pointer resting on a row while output rewrites it
        // would keep the stale "no links" answer. Invalidate on every parse.
        const writeSub = term.onWriteParsed(() => invalidateLinkCache(term));
        host.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKey, true);
        window.addEventListener('blur', onBlur);

        // ── copy without the agent gutter (⌘C / native long-press copy) ──
        // Document capture runs before xterm's own copy listener on its element.
        const onCopy = (e: ClipboardEvent) => {
            if (!e.clipboardData) return;
            const text = terminalCopyText(term, host, e.target);
            if (text == null) return;
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
            e.stopPropagation();
        };
        document.addEventListener('copy', onCopy, true);

        // ── touch: remember when the finger went down (long press ≠ tap) ──
        const onTouchStart = (e: TouchEvent) => { touchStartAt.current = e.timeStamp; };
        if (coarsePointer) host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });

        return () => {
            provider.dispose();
            writeSub.dispose();
            host.removeEventListener('mousemove', onMouseMove, { capture: true } as EventListenerOptions);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('keyup', onKey, true);
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('copy', onCopy, true);
            host.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
            hovered = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- surfaceKey IS the terminal identity
    }, [surfaceKey, isMac, coarsePointer, openCandidate]);

    /**
     * Called first thing from the screen's touchend. true = this tap opened a
     * path and was consumed (preventDefault'd); the caller must skip its own
     * tap handling so the soft keyboard does not come up.
     */
    const consumeTap = useCallback((e: TouchEvent, distanceSquared: number): boolean => {
        const renderer = termRef.current;
        const term = renderer?.raw;
        const p = e.changedTouches[0];
        if (!term || !p || !coarsePointer) return false;
        if (!isPathTapGesture({
            selectMode: selectModeRef.current === true,
            distanceSquared,
            durationMs: e.timeStamp - touchStartAt.current,
            hasDomSelection: hasDomSelection(),
            hasTermSelection: term.hasSelection(),
        })) return false;
        const screen = term.element?.querySelector('.xterm-screen');
        if (!screen || term.cols <= 0 || term.rows <= 0) return false;
        const rect = screen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const col = Math.floor((p.clientX - rect.left) / (rect.width / term.cols));
        const vrow = Math.floor((p.clientY - rect.top) / (rect.height / term.rows));
        if (col < 0 || col >= term.cols || vrow < 0 || vrow >= term.rows) return false;
        const candidate = pathAtCell(term.buffer.active, term.buffer.active.viewportY + vrow, col);
        if (!candidate) return false;
        if (e.cancelable) e.preventDefault();
        void openCandidate(candidate);
        return true;
    }, [termRef, coarsePointer, selectModeRef, openCandidate]);

    return { consumeTap };
}
