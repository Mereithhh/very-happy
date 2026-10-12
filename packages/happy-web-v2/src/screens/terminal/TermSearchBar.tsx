/**
 * TermSearchBar — find in the terminal's scrollback (B-557).
 * Spec: specs/2026-10-terminal-search.md. Pure logic lives in ./termSearch.
 *
 * Mount discipline (why this is NOT inside .term-host): the host carries
 * capture-phase paste / touch / mousedown listeners that route into the pty —
 * a paste into this input would be typed into the shell. The screen renders
 * the bar inside .term-header and CSS floats it over the terminal's top edge.
 *
 * Highlighting uses xterm decorations (proposed API, already enabled), never
 * `term.select()`: the selection is the long-press-copy / select-mode state and
 * search must not rewrite it. Every decoration/marker this bar creates is
 * disposed on close, on re-search, and on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import {
    decorationWindow,
    findTermMatches,
    formatMatchCount,
    indexOfMatchAt,
    matchTermSearchChord,
    pickInitialIndex,
    scrollTargetFor,
    searchInputKeyAction,
    stepIndex,
    type TermMatch,
} from './termSearch';

const SEARCH_DEBOUNCE_MS = 120;
/** Re-search cadence while output streams in (the scan is O(buffer)). */
const REFRESH_THROTTLE_MS = 400;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** xterm decorations accept only `#RRGGBB` — read the --term-search-* tokens once. */
function readColors(): { match: string; active: string; activeFg: string } | null {
    if (typeof document === 'undefined') return null;
    const cs = getComputedStyle(document.documentElement);
    const match = cs.getPropertyValue('--term-search-match-bg').trim();
    const active = cs.getPropertyValue('--term-search-active-bg').trim();
    const activeFg = cs.getPropertyValue('--term-search-active-fg').trim();
    if (!HEX_RE.test(match) || !HEX_RE.test(active) || !HEX_RE.test(activeFg)) return null;
    return { match, active, activeFg };
}

/**
 * Window-capture hotkey (same phase as presetsShortcut/viewShortcuts, so it
 * beats xterm's textarea). Fires ONLY while `isOwnFocus()` — focus inside the
 * terminal or the search bar — so the browser's own ⌘F works everywhere else.
 */
export function useTermSearchHotkey({ enabled, isMac, isOwnFocus, onOpen }: {
    enabled: boolean;
    isMac: boolean;
    isOwnFocus: () => boolean;
    onOpen: () => void;
}) {
    const ref = useRef({ isOwnFocus, onOpen });
    ref.current = { isOwnFocus, onOpen };
    useEffect(() => {
        if (!enabled) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.isComposing || !matchTermSearchChord(e, isMac)) return;
            if (!ref.current.isOwnFocus()) return;
            e.preventDefault();
            e.stopPropagation();
            ref.current.onOpen();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [enabled, isMac]);
}

/**
 * Everything the screen needs, in one call (WebTerminalScreen is a conflict
 * hot zone — keep its hook-in to a couple of lines). Closes itself when
 * `resetKey` (the terminal id) changes.
 */
export function useTermSearchController({ hostRef, isMac, coarsePointer, focusTerminal, resetKey }: {
    hostRef: React.RefObject<HTMLElement | null>;
    isMac: boolean;
    coarsePointer: boolean;
    focusTerminal: () => void;
    resetKey: string | undefined;
}) {
    const [open, setOpen] = useState(false);
    const [signal, setSignal] = useState(0);
    const openSearch = useCallback(() => { setOpen(true); setSignal((n) => n + 1); }, []);
    const focusRef = useRef(focusTerminal);
    focusRef.current = focusTerminal;
    const closeSearch = useCallback(() => {
        setOpen(false);
        // Desktop: hand the keyboard straight back to the terminal. Touch: don't —
        // focusing the terminal would raise the soft keyboard nobody asked for.
        if (!coarsePointer) focusRef.current();
    }, [coarsePointer]);
    useEffect(() => { setOpen(false); }, [resetKey]);
    useTermSearchHotkey({
        enabled: !coarsePointer,
        isMac,
        isOwnFocus: () => {
            const a = typeof document !== 'undefined' ? document.activeElement : null;
            if (!a) return false;
            return !!hostRef.current?.contains(a) || !!(a as Element).closest?.('.term-search');
        },
        onOpen: openSearch,
    });
    return { open, signal, openSearch, closeSearch, toggleSearch: () => (open ? closeSearch() : openSearch()) };
}

export function TermSearchBar({ getTerm, onClose, openSignal, coarsePointer }: {
    /** Live xterm instance (the screen's renderer can rebuild it; re-read every run). */
    getTerm: () => Terminal | null;
    /** Close request (Esc / ✕). The screen decides where focus goes. */
    onClose: () => void;
    /** Bumped by the screen on every open request — re-focuses + selects the input. */
    openSignal: number;
    coarsePointer: boolean;
}) {
    const { t } = useTranslation();
    const ime = useImeGuard();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [query, setQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [count, setCount] = useState({ active: -1, total: 0, truncated: false });

    // Mutable search state — decorations are imperative xterm objects, not React state.
    const st = useRef({
        term: null as Terminal | null,
        matches: [] as TermMatch[],
        active: -1,
        truncated: false,
        decos: [] as IDecoration[],
        activeDecos: [] as IDecoration[],
        markers: [] as IMarker[],
        /** Follows the active hit's line through scrollback trimming. */
        anchor: null as { marker: IMarker; col: number } | null,
        writeSub: null as IDisposable | null,
        refreshTimer: 0 as ReturnType<typeof setTimeout> | 0,
        lastRefresh: 0,
        colors: null as ReturnType<typeof readColors>,
    });
    const queryRef = useRef({ query, caseSensitive });
    queryRef.current = { query, caseSensitive };

    const clearDecos = useCallback((which: 'all' | 'active') => {
        const s = st.current;
        for (const d of s.activeDecos) d.dispose();
        s.activeDecos = [];
        if (which === 'active') return;
        for (const d of s.decos) d.dispose();
        for (const m of s.markers) m.dispose();
        s.decos = [];
        s.markers = [];
    }, []);

    const markerAt = (term: Terminal, row: number): IMarker | undefined => {
        const b = term.buffer.active;
        // registerMarker is relative to the cursor line (absolute = baseY + cursorY).
        return term.registerMarker(row - (b.baseY + b.cursorY));
    };

    const paintActive = useCallback((term: Terminal) => {
        const s = st.current;
        clearDecos('active');
        s.anchor?.marker.dispose();
        s.anchor = null;
        const m = s.matches[s.active];
        if (!m) return;
        const first = m.segments[0];
        const anchorMarker = markerAt(term, first.row);
        if (anchorMarker) s.anchor = { marker: anchorMarker, col: first.col };
        if (!s.colors) return;
        for (const seg of m.segments) {
            const marker = markerAt(term, seg.row);
            if (!marker) continue;
            const d = term.registerDecoration({
                marker, x: seg.col, width: seg.width, layer: 'top',
                backgroundColor: s.colors.active, foregroundColor: s.colors.activeFg,
            });
            if (d) { d.onDispose(() => marker.dispose()); s.activeDecos.push(d); }
            else marker.dispose();
        }
    }, [clearDecos]);

    const paintAll = useCallback((term: Terminal) => {
        const s = st.current;
        clearDecos('all');
        if (!s.colors) return;
        const [from, to] = decorationWindow(s.matches.length, s.active);
        for (let i = from; i < to; i++) {
            for (const seg of s.matches[i].segments) {
                const marker = markerAt(term, seg.row);
                if (!marker) continue;
                s.markers.push(marker);
                const d = term.registerDecoration({
                    marker, x: seg.col, width: seg.width, layer: 'bottom', backgroundColor: s.colors.match,
                });
                if (d) s.decos.push(d);
            }
        }
    }, [clearDecos]);

    const reveal = (term: Terminal) => {
        const s = st.current;
        const m = s.matches[s.active];
        if (!m) return;
        const b = term.buffer.active;
        const target = scrollTargetFor(m.segments[0].row, b.viewportY, term.rows);
        if (target !== null) term.scrollToLine(target);
    };

    const publish = () => {
        const s = st.current;
        setCount({ active: s.active, total: s.matches.length, truncated: s.truncated });
    };

    // Forward-declared so the write subscription can call the latest run().
    const runRef = useRef<(mode: 'fresh' | 'refresh') => void>(() => {});

    const ensureSubscribed = (term: Terminal) => {
        const s = st.current;
        if (s.term === term && s.writeSub) return;
        s.writeSub?.dispose();
        s.term = term;
        s.colors = readColors();
        s.writeSub = term.onWriteParsed(() => {
            if (s.refreshTimer) return;
            const wait = Math.max(0, REFRESH_THROTTLE_MS - (Date.now() - s.lastRefresh));
            s.refreshTimer = setTimeout(() => { s.refreshTimer = 0; runRef.current('refresh'); }, wait);
        });
    };

    /**
     * fresh   — query/case changed: pick the hit nearest the viewport and scroll to it.
     * refresh — buffer changed under an open bar: keep the same hit (by its marker), never scroll.
     */
    runRef.current = (mode) => {
        const term = getTerm();
        const s = st.current;
        if (!term) return;
        ensureSubscribed(term);
        s.lastRefresh = Date.now();
        const { query: q, caseSensitive: cs } = queryRef.current;
        const prevAnchor = s.anchor && s.anchor.marker.line >= 0 ? { row: s.anchor.marker.line, col: s.anchor.col } : null;
        const { matches, truncated } = findTermMatches(term.buffer.active, q, { caseSensitive: cs });
        s.matches = matches;
        s.truncated = truncated;
        const b = term.buffer.active;
        let next = -1;
        if (mode === 'refresh' && prevAnchor) next = indexOfMatchAt(matches, prevAnchor.row, prevAnchor.col);
        if (next < 0) next = pickInitialIndex(matches, b.viewportY, b.viewportY + term.rows - 1);
        s.active = next;
        paintAll(term);
        paintActive(term);
        if (mode === 'fresh') reveal(term);
        publish();
    };

    const step = (dir: 1 | -1) => {
        const term = getTerm();
        const s = st.current;
        if (!term) return;
        if (s.term !== term) { runRef.current('fresh'); return; }
        if (s.matches.length === 0) return;
        const prevWindow = decorationWindow(s.matches.length, s.active);
        s.active = stepIndex(s.active, s.matches.length, dir);
        const nextWindow = decorationWindow(s.matches.length, s.active);
        if (prevWindow[0] !== nextWindow[0]) paintAll(term);
        paintActive(term);
        reveal(term);
        publish();
    };

    // Debounced search on query/case change.
    useEffect(() => {
        const id = setTimeout(() => runRef.current('fresh'), query ? SEARCH_DEBOUNCE_MS : 0);
        return () => clearTimeout(id);
    }, [query, caseSensitive]);

    // Focus + select on every open request (⌘F while already open re-selects).
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.select();
    }, [openSignal]);

    // Teardown: every decoration/marker/subscription this bar created.
    useEffect(() => () => {
        const s = st.current;
        if (s.refreshTimer) clearTimeout(s.refreshTimer);
        s.writeSub?.dispose();
        s.anchor?.marker.dispose();
        for (const d of s.activeDecos) d.dispose();
        for (const d of s.decos) d.dispose();
        for (const m of s.markers) m.dispose();
    }, []);

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // Up = older: new output lands at the bottom (VS Code terminal does the same).
        const action = searchInputKeyAction(e, ime.isGuarded(e));
        if (!action) return;
        e.preventDefault();
        if (action === 'close') {
            e.stopPropagation();
            onClose();
        } else {
            step(action === 'next' ? 1 : -1);
        }
    };

    const hasQuery = query.length > 0;
    return (
        <div className={`term-search${coarsePointer ? ' term-search--coarse' : ''}`} role="search" aria-label={t('terminal.search')}>
            <input
                ref={inputRef}
                className="term-search-input"
                type="text"
                value={query}
                placeholder={t('terminal.searchPlaceholder')}
                aria-label={t('terminal.searchPlaceholder')}
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
            />
            <span
                className={`term-search-count mono${hasQuery && count.total === 0 ? ' is-empty' : ''}`}
                aria-live="polite"
            >
                {hasQuery ? formatMatchCount(count.active, count.total, count.truncated) : ''}
            </span>
            <button
                type="button"
                className={`term-search-btn term-search-case${caseSensitive ? ' is-on' : ''}`}
                aria-pressed={caseSensitive}
                aria-label={t('terminal.searchCaseSensitive')}
                title={t('terminal.searchCaseSensitive')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setCaseSensitive((v) => !v)}
            >
                Aa
            </button>
            <button
                type="button"
                className="term-search-btn"
                aria-label={t('terminal.searchPrevious')}
                title={`${t('terminal.searchPrevious')} (Enter)`}
                disabled={count.total === 0}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => step(-1)}
            >
                <ChevronUp size={16} />
            </button>
            <button
                type="button"
                className="term-search-btn"
                aria-label={t('terminal.searchNext')}
                title={`${t('terminal.searchNext')} (Shift+Enter)`}
                disabled={count.total === 0}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => step(1)}
            >
                <ChevronDown size={16} />
            </button>
            <button
                type="button"
                className="term-search-btn"
                aria-label={t('terminal.searchClose')}
                title={`${t('terminal.searchClose')} (Esc)`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClose}
            >
                <X size={16} />
            </button>
        </div>
    );
}
