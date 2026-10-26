/**
 * SessionSearchPanel (B-650, `specs/2026-10-projects.md` §7) — search every
 * session of the account: titles and metadata (instant, Web-local), what was
 * said (every online machine's daemon `history-search`, in parallel) and the
 * messages this tab already holds. One row per session with up to three
 * highlighted snippets; a click opens the session on the hit.
 *
 * Singleton mounted in AppLayout (same pattern as the command palette).
 * Entries: the sidebar 🔍, ⌘K「搜索会话…」, ⌘⇧F (Ctrl+Shift+F off macOS,
 * except inside a web terminal, whose own find owns that chord).
 * Desktop: floating panel over a scrim; phone: full screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Archive, Download, Search, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Combobox, SelectMenu } from '@/ui';
import { storage, useAllMachines } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { useProjects } from '@/sync/projects';
import { IS_MAC } from '@/app/appChord';
import { isHibernated } from '@/app/sessionHibernation';
import { isAssistantSession } from '@/assistant/assistantSession';
import { sessionHasPendingRequests } from '@/screens/board/boardItems';
import { getSessionName, getSessionSidebarSubtitle } from '@/utils/sessionUtils';
import { machineLabel } from '@/utils/machineUtils';
import { listArrowDelta } from '@/utils/listArrowKey';
import { onQuickOpen } from '@/screens/quickopen/quickOpenEvents';
import { openCommandPalette } from '@/screens/command/CommandPalette';
import { ImportHistoryModal } from '@/screens/sessions/ImportHistoryModal';
import { findTrackedSessionId, splitHighlights } from '@/screens/sessions/historySearch';
import { shortenCwd, type HistoryAgent } from '@/screens/sessions/claudeHistoryImport';
import { formatSessionAge } from '@/screens/sessions/newTerminalAttach';
import { requestChatJump } from './chatJump';
import { pickerOwnsKey } from './pickerOwnsKey';
import { SESSION_SEARCH_HINT, SESSION_SEARCH_OPEN_EVENT } from './sessionSearchEvents';
import { useContentSearch } from './useContentSearch';
import {
    daemonAgentFor,
    EMPTY_FILTERS,
    importableAllowed,
    machinesInScope,
    matchSessionSearchChord,
    mergeContentHits,
    parseSessionSearchQuery,
    passesFilters,
    rankRows,
    searchLocalSessions,
    sessionSearchQueryIsEmpty,
    summarizeCoverage,
    type MachineContentHit,
    type Range,
    type ResultSnippet,
    type SessionSearchDoc,
    type SessionSearchFilters,
    type SessionSearchRow,
    type StatusFilter,
    type TimeFilter,
} from './sessionSearch';
import './sessionsearch.css';
import { OVERLAY_PRIORITY, useOverlayTurn } from '@/app/overlayQueue';

const LOCAL_DEBOUNCE_MS = 120;
const MAX_ROWS = 60;

export function SessionSearch() {
    const [open, setOpen] = useState(false);
    const [importTarget, setImportTarget] = useState<{ machineId: string; agent: HistoryAgent; query: string } | null>(null);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target instanceof Element ? e.target : null;
            const inTerminal = !!target?.closest('.xterm');
            if (!matchSessionSearchChord(e, IS_MAC, inTerminal)) return;
            e.preventDefault();
            e.stopPropagation();
            setOpen((prev) => !prev);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);
    useEffect(() => {
        const onOpen = () => setOpen(true);
        window.addEventListener(SESSION_SEARCH_OPEN_EVENT, onOpen);
        return () => window.removeEventListener(SESSION_SEARCH_OPEN_EVENT, onOpen);
    }, []);
    useEffect(() => onQuickOpen(() => setOpen(false)), []);
    // B-831: page-blocking — takes an `interaction` turn (overlayQueue), so the
    // release notes step aside and a sign-in expiry dialog is never stacked on it.
    const turn = useOverlayTurn(open, OVERLAY_PRIORITY.interaction);

    return (
        <>
            {open && turn && (
                <SessionSearchPanel
                    onClose={() => setOpen(false)}
                    onImport={(t) => { setOpen(false); setImportTarget(t); }}
                />
            )}
            {importTarget && (
                <ImportHistoryModal
                    initialMode="search"
                    initialMachineId={importTarget.machineId}
                    initialAgent={importTarget.agent}
                    initialQuery={importTarget.query}
                    onClose={() => setImportTarget(null)}
                />
            )}
        </>
    );
}

function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
    return (
        <>
            {splitHighlights(text, ranges).map((seg, i) =>
                seg.hit ? <mark key={i} className="ss-mark">{seg.text}</mark> : <span key={i}>{seg.text}</span>)}
        </>
    );
}

function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

interface SessionFacts {
    session: Session;
    doc: SessionSearchDoc;
    agent: string | null;
    machineId: string | null;
    projectId: string | null;
    waiting: boolean;
}

function SessionSearchPanel({ onClose, onImport }: {
    onClose: () => void;
    onImport: (t: { machineId: string; agent: HistoryAgent; query: string }) => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [input, setInput] = useState('');
    const [filters, setFilters] = useState<SessionSearchFilters>(EMPTY_FILTERS);
    const [active, setActive] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounced = useDebounced(input, LOCAL_DEBOUNCE_MS);
    const q = useMemo(() => parseSessionSearchQuery(debounced), [debounced]);
    const empty = sessionSearchQueryIsEmpty(q);

    const sessionsById = storage((s) => s.sessions);
    const machines = useAllMachines({ includeOffline: true });
    const projects = useProjects();

    useEffect(() => { inputRef.current?.focus(); }, []);

    const projectOf = useMemo(() => {
        const m = new Map<string, string>();
        for (const mem of projects.members) m.set(mem.sessionId, mem.projectId);
        return m;
    }, [projects.members]);
    const projectName = useMemo(() => new Map(projects.projects.map((p) => [p.id, p.name])), [projects.projects]);
    const machineName = useMemo(() => new Map(machines.map((m) => [m.id, machineLabel(m)])), [machines]);

    // Every searchable session (archived and terminal mirrors included; the assistant is not a conversation).
    const facts = useMemo<SessionFacts[]>(() => {
        const out: SessionFacts[] = [];
        for (const s of Object.values(sessionsById)) {
            if (isAssistantSession(s)) continue;
            const archived = !(s.active || isHibernated(s));
            const projectId = projectOf.get(s.id) ?? null;
            const machineId = s.metadata?.machineId ?? null;
            const flavor = s.metadata?.flavor?.trim() || null;
            const agent = !flavor || flavor === 'terminal-mirror' ? 'claude' : flavor;
            const extra = [
                projectId ? projectName.get(projectId) : '',
                machineId ? machineName.get(machineId) : '',
                s.metadata?.path ?? '',
            ].filter(Boolean).join(' ');
            out.push({
                session: s,
                agent,
                machineId,
                projectId,
                waiting: sessionHasPendingRequests(s) || s.metadata?.board?.attention === 'review' || s.metadata?.board?.attention === 'blocked',
                doc: {
                    sessionId: s.id,
                    title: getSessionName(s),
                    subtitle: getSessionSidebarSubtitle(s),
                    extra,
                    tags: s.metadata?.tags ?? [],
                    updatedAt: s.updatedAt,
                    archived,
                },
            });
        }
        return out;
    }, [sessionsById, projectOf, projectName, machineName]);

    const now = Date.now();
    const filtered = useMemo(
        () => facts.filter((f) => passesFilters({ ...f, archived: f.doc.archived, updatedAt: f.doc.updatedAt }, filters, now)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [facts, filters],
    );
    const docMap = useMemo(() => new Map(filtered.map((f) => [f.doc.sessionId, f.doc])), [filtered]);

    // Source 2 scope: machines owning sessions + every online machine, narrowed by the machine filter.
    const scopeMachines = useMemo(() => {
        const owning = new Set(facts.map((f) => f.machineId).filter((x): x is string => !!x));
        const list = machinesInScope(machines, owning);
        return filters.machineId ? list.filter((m) => m.id === filters.machineId) : list;
    }, [machines, facts, filters.machineId]);
    const daemonAgent = daemonAgentFor(filters);
    const content = useContentSearch({
        query: daemonAgent === null ? '' : q.text,
        agent: daemonAgent ?? undefined,
        machines: scopeMachines,
    });

    const rows = useMemo<SessionSearchRow[]>(() => {
        if (empty) return [];
        const cached = new Map<string, readonly Message[]>();
        const all = storage.getState().sessionMessages;
        for (const f of filtered) {
            const m = all[f.doc.sessionId]?.messages;
            if (m && m.length) cached.set(f.doc.sessionId, m);
        }
        const local = searchLocalSessions(filtered.map((f) => f.doc), cached, q);
        const rawSessions = Object.values(sessionsById);
        const hits: MachineContentHit[] = [];
        for (const [machineId, list] of content.hits) {
            for (const hit of list) {
                const tracked = findTrackedSessionId(hit.entry.agent, hit.entry.agent === 'claude' ? hit.entry.claudeSessionId : hit.entry.codexThreadId, rawSessions);
                if (!tracked) {
                    if (filters.time !== 'any' && !passesFilters({ archived: false, waiting: false, agent: hit.entry.agent, machineId, projectId: null, updatedAt: hit.entry.updatedAt }, { ...filters, status: 'all', projectId: null }, now)) continue;
                }
                hits.push({
                    machineId,
                    hit,
                    ...(tracked ? { sessionId: tracked.sessionId } : {}),
                    subtitle: [machineName.get(machineId), hit.entry.agent, shortenCwd(hit.entry.cwd, machines.find((m) => m.id === machineId)?.metadata?.homeDir)].filter(Boolean).join(' · '),
                });
            }
        }
        const merged = hits.length ? mergeContentHits(local, hits, docMap, q, { includeImportable: importableAllowed(filters) }) : rankRows(local);
        return merged.slice(0, MAX_ROWS);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [empty, filtered, q, content.hits, docMap, sessionsById, filters, machineName, machines]);

    useEffect(() => { setActive(0); }, [rows.length, debounced]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('.ss-row.is-active')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const coverage = useMemo(() => summarizeCoverage(content.coverage), [content.coverage]);

    const openRow = (row: SessionSearchRow, snippet?: ResultSnippet) => {
        if (row.importable) {
            onImport({ machineId: row.importable.machineId, agent: row.importable.entry.agent, query: q.text });
            return;
        }
        if (!row.sessionId) return;
        const sn = snippet ?? row.snippets[0];
        if (sn && q.terms.length) {
            requestChatJump(row.sessionId, {
                terms: q.terms,
                ...(sn.messageId ? { messageId: sn.messageId } : { snippet: sn.text }),
                ...(sn.at !== undefined ? { at: sn.at } : {}),
            });
        }
        onClose();
        navigate(`/session/${row.sessionId}`);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.nativeEvent.isComposing) return;
        if (pickerOwnsKey(e)) return;
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        // Arrows / Enter drive the result list only from the search field: a focused filter
        // picker trigger or snippet button keeps its own keys.
        if (e.target !== inputRef.current) return;
        const delta = listArrowDelta(e);
        if (delta !== null) {
            e.preventDefault();
            if (rows.length) setActive((i) => (i + delta + rows.length) % rows.length);
            return;
        }
        if (e.key === 'Enter') {
            const row = rows[active];
            if (row) { e.preventDefault(); openRow(row); }
        }
    };

    const agents = useMemo(() => [...new Set(facts.map((f) => f.agent).filter((a): a is string => !!a))].sort(), [facts]);
    const statusOptions: Array<{ v: StatusFilter; label: string }> = [
        { v: 'all', label: t('sessionSearch.statusAll') },
        { v: 'live', label: t('sessionSearch.statusLive') },
        { v: 'waiting', label: t('sessionSearch.statusWaiting') },
        { v: 'archived', label: t('sessionSearch.statusArchived') },
    ];
    const timeOptions: Array<{ v: TimeFilter; label: string }> = [
        { v: 'any', label: t('sessionSearch.timeAny') },
        { v: '1d', label: t('sessionSearch.time1d') },
        { v: '7d', label: t('sessionSearch.time7d') },
        { v: '30d', label: t('sessionSearch.time30d') },
    ];
    const setFilter = <K extends keyof SessionSearchFilters>(k: K, v: SessionSearchFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

    const names = (list: { name: string }[]) => list.map((m) => m.name).join(', ');
    const notice: string[] = [];
    if (coverage.offline.length) notice.push(t('sessionSearch.machinesOffline', { count: coverage.offline.length }));
    if (coverage.unsupported.length) notice.push(t('sessionSearch.machinesOldCli', { count: coverage.unsupported.length }));
    if (coverage.failed.length) notice.push(t('sessionSearch.machinesFailed', { count: coverage.failed.length }));
    if (coverage.indexing.length) notice.push(t('sessionSearch.machinesIndexing', { count: coverage.indexing.length }));
    const noticeTitle = [
        coverage.offline.length ? `${t('sessionSearch.offlineLabel')}: ${names(coverage.offline)}` : '',
        coverage.unsupported.length ? `${t('sessionSearch.oldCliLabel')}: ${names(coverage.unsupported)}` : '',
        coverage.failed.length ? `${t('sessionSearch.failedLabel')}: ${names(coverage.failed)}` : '',
        coverage.indexing.length ? `${t('sessionSearch.indexingLabel')}: ${coverage.indexing.map((m) => `${m.name}${m.progress ? ` ${m.progress.done}/${m.progress.total}` : ''}`).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const contentSkipped = !empty && daemonAgent === null;

    const roleLabel = (s: ResultSnippet) => s.role === 'user' ? t('sessionSearch.roleUser') : s.role === 'assistant' ? t('sessionSearch.roleAgent') : t('sessionSearch.roleTool');

    return createPortal(
        <div className="ss-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="ss-panel" role="dialog" aria-modal="true" aria-label={t('sessionSearch.title')} onKeyDown={onKeyDown}>
                <div className="ss-search">
                    <Search size={16} className="ss-search-icon" aria-hidden />
                    <input
                        ref={inputRef}
                        className="ss-search-input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={t('sessionSearch.placeholder')}
                        aria-label={t('sessionSearch.title')}
                        spellCheck={false}
                        autoComplete="off"
                    />
                    <button type="button" className="ss-close" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
                        <X size={16} />
                    </button>
                </div>
                <div className="ss-filters">
                    <div className="vh-segmented ss-status" role="radiogroup" aria-label={t('sessionSearch.statusLabel')}>
                        {statusOptions.map((o) => (
                            <button key={o.v} type="button" role="radio" aria-checked={filters.status === o.v}
                                className={`vh-segmented-item${filters.status === o.v ? ' is-active' : ''}`}
                                onClick={() => setFilter('status', o.v)}>{o.label}</button>
                        ))}
                    </div>
                    <Combobox
                        variant="chip"
                        className="ss-filter"
                        label={t('sessionSearch.projectLabel')}
                        value={filters.projectId ?? ''}
                        onChange={(v) => setFilter('projectId', v || null)}
                        options={[
                            { value: '', label: t('sessionSearch.projectAny') },
                            ...projects.projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name })),
                        ]}
                    />
                    <SelectMenu
                        variant="chip"
                        className="ss-filter"
                        label={t('sessionSearch.agentLabel')}
                        value={filters.agent ?? ''}
                        onChange={(v) => setFilter('agent', v || null)}
                        options={[{ value: '', label: t('sessionSearch.agentAny') }, ...agents.map((a) => ({ value: a, label: a }))]}
                    />
                    <Combobox
                        variant="chip"
                        className="ss-filter"
                        label={t('sessionSearch.machineLabel')}
                        value={filters.machineId ?? ''}
                        onChange={(v) => setFilter('machineId', v || null)}
                        options={[
                            { value: '', label: t('sessionSearch.machineAny') },
                            ...machines.map((m) => ({ value: m.id, label: machineLabel(m), ...(m.active ? {} : { meta: t('sessionSearch.offlineLabel') }) })),
                        ]}
                    />
                    <SelectMenu
                        variant="chip"
                        className="ss-filter"
                        label={t('sessionSearch.timeLabel')}
                        value={filters.time}
                        onChange={(v) => setFilter('time', v)}
                        options={timeOptions.map((o) => ({ value: o.v, label: o.label }))}
                    />
                </div>
                {!empty && (notice.length > 0 || contentSkipped || coverage.pending.length > 0) && (
                    <div className={`ss-notice${coverage.incomplete || contentSkipped ? ' is-incomplete' : ''}`} role="status">
                        {contentSkipped
                            ? t('sessionSearch.contentNotIndexed')
                            : notice.length > 0
                                ? `${notice.join(' · ')}${coverage.incomplete ? t('sessionSearch.incompleteSuffix') : ''}`
                                : t('sessionSearch.searchingMachines', { count: coverage.pending.length })}
                        {notice.length > 0 && coverage.pending.length > 0 && ` · ${t('sessionSearch.searchingMachines', { count: coverage.pending.length })}`}
                    </div>
                )}
                {!empty && notice.length > 0 && noticeTitle && (
                    <div className="ss-notice-detail">{noticeTitle.split('\n').map((l) => <div key={l}>{l}</div>)}</div>
                )}
                <div className="ss-list" ref={listRef} role="listbox" aria-label={t('sessionSearch.title')}>
                    {empty ? (
                        <div className="ss-empty">
                            <div>{t('sessionSearch.emptyHint')}</div>
                            {/* The sidebar 🔍 used to open ⌘K; on a phone it was the palette's only door. */}
                            <button type="button" className="ss-palette-link" onClick={() => { onClose(); openCommandPalette(); }}>
                                {t('sessionSearch.openPalette')}
                            </button>
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="ss-empty">{coverage.pending.length > 0 ? t('sessionSearch.searching') : t('sessionSearch.noResults')}</div>
                    ) : rows.map((row, i) => (
                        <div key={row.key} role="option" aria-selected={i === active}
                            className={`ss-row${i === active ? ' is-active' : ''}`}
                            onMouseMove={() => { if (i !== active) setActive(i); }}
                            onClick={() => openRow(row)}>
                            <div className="ss-row-head">
                                <span className="ss-row-title"><Highlighted text={row.title} ranges={row.titleRanges} /></span>
                                {row.archived && <span className="ss-badge"><Archive size={11} aria-hidden />{t('sessionSearch.archivedBadge')}</span>}
                                {row.importable && <span className="ss-badge"><Download size={11} aria-hidden />{t('sessionSearch.importableBadge')}</span>}
                                <span className="ss-row-age">{formatSessionAge(row.updatedAt, now)}</span>
                            </div>
                            <div className="ss-row-sub"><Highlighted text={row.subtitle} ranges={row.subtitleRanges} /></div>
                            {row.snippets.map((s, k) => (
                                <button key={k} type="button" className="ss-snippet"
                                    onClick={(e) => { e.stopPropagation(); openRow(row, s); }}>
                                    <span className="ss-snippet-role">{roleLabel(s)}</span>
                                    <span className="ss-snippet-text"><Highlighted text={s.text} ranges={s.ranges} /></span>
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
                <div className="ss-foot">
                    <span>{t('sessionSearch.footKeys')}</span>
                    <span className="ss-foot-hint">{SESSION_SEARCH_HINT}</span>
                </div>
            </div>
        </div>,
        document.body,
    );
}
