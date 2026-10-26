/**
 * QuickOpen — ⌘P fuzzy file finder on the session page (B-576).
 * Spec: specs/2026-10-terminal-paths-and-quick-open.md D4.
 *
 * Mounted by SessionDetailScreen only, so the ⌘P / Ctrl+P interception (it
 * would otherwise print the page) exists exactly while a session is on screen.
 * Phones reach it from ⌘K「打开文件…」(openQuickOpen()).
 *
 * The file list is the project list FilesPanel already uses (git ls-files via
 * the session's bash RPC, cached per machine:path): shown immediately from the
 * cache and refreshed once per open. No list (not a git repo, wrapper offline,
 * older CLI) → explain and offer the folder browser instead.
 *
 * Opening reuses chat's FilePathLink entry (openFsPreview), which docks the
 * preview into this session's right-hand workspace panel.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, FolderOpen, Search } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { IS_MAC, isAppChord } from '@/app/appChord';
import { storage, useSession, useSessionProjectFiles } from '@/sync/storage';
import { getProjectFiles } from '@/sync/projectFiles';
import { openFsPreview } from '@/sync/filePreviewOpen';
import { resolveAgainstCwd } from '../session/toolFilePath';
import { withSessionPanel } from '../session/sessionPanelState';
import { createQuickOpenRanker, highlightRuns, QUICK_OPEN_DEBOUNCE_MS, QUICK_OPEN_DEBOUNCE_THRESHOLD, QUICK_OPEN_RESULT_LIMIT, type QuickOpenMatch } from './quickOpenScore';
import { readQuickOpenHistory, recordQuickOpen } from './quickOpenHistory';
import { COMMAND_PALETTE_OPEN_EVENT, matchQuickOpenChord, onQuickOpen, openQuickOpen } from './quickOpenEvents';
import '../command/commandpalette.css';
import './quickopen.css';
import { dismissFeatureTip } from '@/components/featureTips/FeatureTips';
import { listArrowDelta } from '@/utils/listArrowKey';
import { OVERLAY_PRIORITY, useOverlayTurn } from '@/app/overlayQueue';

export function QuickOpen({ sessionId }: { sessionId: string }) {
    const [open, setOpen] = useState(false);
    const openRef = useRef(open);
    openRef.current = open;
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.isComposing || !matchQuickOpenChord(e, IS_MAC)) return;
            e.preventDefault(); // the browser's print dialog
            e.stopPropagation();
            // Opening goes through the event so the ⌘K palette closes itself (one modal at a time).
            if (openRef.current) setOpen(false);
            else openQuickOpen();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);
    useEffect(() => onQuickOpen(() => setOpen(true)), []);
    // B-588: using ⌘P retires its one-time tip.
    useEffect(() => { if (open) dismissFeatureTip('quick-open'); }, [open]);
    // ⌘K (or its programmatic open) shows the palette: step aside, never stack two modals.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (isAppChord(e) && (e.key === 'k' || e.key === 'K')) setOpen(false); };
        const onPalette = () => setOpen(false);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onPalette);
        return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onPalette); };
    }, []);
    useEffect(() => { setOpen(false); }, [sessionId]);
    // B-831: page-blocking — takes an `interaction` turn (overlayQueue), so the
    // release notes step aside and a sign-in expiry dialog is never stacked on it.
    const turn = useOverlayTurn(open, OVERLAY_PRIORITY.interaction);
    if (!open || !turn) return null;
    return <QuickOpenPanel sessionId={sessionId} onClose={() => setOpen(false)} />;
}

function Highlighted({ text, positions, offset }: { text: string; positions: readonly number[]; offset: number }) {
    return (
        <>
            {highlightRuns(text, positions, offset).map((r, i) =>
                r.hit ? <mark key={i} className="qo-hit">{r.text}</mark> : <span key={i}>{r.text}</span>)}
        </>
    );
}

function QuickOpenPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { t } = useTranslation();
    const ime = useImeGuard();
    const [searchParams, setSearchParams] = useSearchParams();
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId ?? null;
    const cwd = session?.metadata?.path ?? null;
    const project = machineId && cwd ? `${machineId}:${cwd}` : null;
    const projectFiles = useSessionProjectFiles(sessionId);
    const [fetching, setFetching] = useState(true);
    const [query, setQuery] = useState('');
    const deferredQuery = useDeferredValue(query);
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const history = useMemo(() => (project ? readQuickOpenHistory(project) : []), [project]);

    useEffect(() => {
        const id = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, []);

    // Stale-while-revalidate, once per open (same as useSessionFiles).
    useEffect(() => {
        let cancelled = false;
        const pathKey = storage.getState().getSessionPathKey(sessionId);
        if (!pathKey) { setFetching(false); return; }
        setFetching(true);
        getProjectFiles(sessionId)
            // A failed refresh (wrapper offline) must not wipe a good cached list.
            .then((files) => { if (!cancelled && files) storage.getState().applyProjectFiles(pathKey, files); })
            .catch(() => { /* keep the cached list */ })
            .finally(() => { if (!cancelled) setFetching(false); });
        return () => { cancelled = true; };
    }, [sessionId]);

    const files = useMemo(() => projectFiles?.files.map((f) => f.fullPath) ?? [], [projectFiles]);
    // Big repos: scoring runs on the main thread — debounce typing a little and
    // narrow incrementally while the query only grows (createQuickOpenRanker).
    const [settledQuery, setSettledQuery] = useState(deferredQuery);
    useEffect(() => {
        if (files.length <= QUICK_OPEN_DEBOUNCE_THRESHOLD) { setSettledQuery(deferredQuery); return; }
        const timer = setTimeout(() => setSettledQuery(deferredQuery), QUICK_OPEN_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [deferredQuery, files.length]);
    const ranker = useMemo(() => createQuickOpenRanker(), []);
    const results = useMemo<QuickOpenMatch[]>(
        () => ranker(settledQuery, files, history),
        [ranker, settledQuery, files, history],
    );
    const recentCount = useMemo(() => {
        if (settledQuery.trim()) return 0;
        const recent = new Set(history);
        let n = 0;
        while (n < results.length && recent.has(results[n].path)) n++;
        return n;
    }, [settledQuery, history, results]);
    useEffect(() => { setActive(0); }, [settledQuery]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-qo-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const openPath = useCallback((fullPath: string) => {
        if (!machineId) return;
        if (project) recordQuickOpen(project, fullPath);
        openFsPreview({ sessionId, machineId, path: resolveAgainstCwd(fullPath, cwd), mode: 'file' });
        onClose();
    }, [machineId, project, sessionId, cwd, onClose]);

    const browse = useCallback(() => {
        setSearchParams(withSessionPanel(searchParams, 'browse'));
        onClose();
    }, [searchParams, setSearchParams, onClose]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (ime.isGuarded(e)) return;
        // B-655: only a bare ↑/↓ moves the list; ⌘/Shift+↑/↓ edit the query.
        const delta = listArrowDelta(e);
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (delta !== null) { e.preventDefault(); setActive((a) => (results.length ? (a + delta + results.length) % results.length : 0)); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const hit = results[active];
            if (hit) openPath(hit.path);
        }
    };

    const unavailable = !machineId || !cwd || (!projectFiles && !fetching);
    let body: React.ReactNode;
    if (unavailable) {
        body = (
            <div className="qo-state">
                <p className="qo-state-title">{t('quickOpen.unavailableTitle')}</p>
                <p className="qo-state-body">{machineId && cwd ? t('quickOpen.unavailableBody') : t('quickOpen.noSession')}</p>
                {machineId && cwd && (
                    <button type="button" className="qo-browse" onClick={browse}>
                        <FolderOpen size={15} aria-hidden />
                        <span>{t('quickOpen.browse')}</span>
                    </button>
                )}
            </div>
        );
    } else if (!projectFiles) {
        body = <div className="cp-empty">{t('quickOpen.loading')}</div>;
    } else if (results.length === 0) {
        body = <div className="cp-empty">{t('quickOpen.noMatches')}</div>;
    } else {
        body = results.map((m, index) => {
            const nameStart = m.path.lastIndexOf('/') + 1;
            const name = m.path.slice(nameStart);
            const dir = m.path.slice(0, Math.max(0, nameStart - 1));
            return (
                <div key={m.path}>
                    {index === 0 && recentCount > 0 && <div className="cp-group-label">{t('quickOpen.recent')}</div>}
                    {index === recentCount && recentCount > 0 && <div className="cp-group-label">{t('quickOpen.files')}</div>}
                    <button
                        type="button"
                        data-qo-index={index}
                        className={`cp-item${index === active ? ' is-active' : ''}`}
                        onMouseMove={() => { if (index !== active) setActive(index); }}
                        onClick={() => openPath(m.path)}
                        title={m.path}
                    >
                        <span className="cp-item-icon"><FileText size={16} /></span>
                        <span className="cp-item-text">
                            <span className="cp-item-title qo-name"><Highlighted text={name} positions={m.positions} offset={nameStart} /></span>
                            {dir && <span className="cp-item-sub"><Highlighted text={dir} positions={m.positions} offset={0} /></span>}
                        </span>
                    </button>
                </div>
            );
        });
    }

    return (
        <div className="cp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div
                className="cp-panel qo-panel"
                role="dialog"
                aria-modal="true"
                aria-label={t('quickOpen.title')}
                onKeyDown={onKeyDown}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
            >
                <div className="cp-search">
                    <Search size={16} className="cp-search-icon" />
                    <input
                        ref={inputRef}
                        className="cp-search-input"
                        type="text"
                        value={query}
                        placeholder={t('quickOpen.placeholder')}
                        onChange={(e) => setQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        aria-label={t('quickOpen.title')}
                    />
                </div>
                <div className="cp-list vh-scroll-fade" ref={listRef}>{body}</div>
                {!unavailable && results.length >= QUICK_OPEN_RESULT_LIMIT && (
                    <div className="cp-footer"><span>{t('quickOpen.truncatedHint', { count: QUICK_OPEN_RESULT_LIMIT })}</span></div>
                )}
            </div>
        </div>
    );
}
