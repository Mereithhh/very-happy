/**
 * B-873 `/issues` (spec §10): list (grouped by status, done/cancelled folded)
 * and board (status columns; drag on a fine pointer, ⋯ 改状态 everywhere),
 * filter chips 状态 / 项目 / 指派 / 标签 / 优先级 kept in the URL
 * (`/todos` lands on `?assignee=none`), My Issues tabs 指派给我 / 等我处理 /
 * 我创建的, and 新建 issue. Opening the page imports legacy Todos once (§8).
 */
import { useEffect, useMemo, useState, type DragEvent, type LiHTMLAttributes } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, CircleDot, ExternalLink, Flag, FolderKanban, LayoutList, ListTodo, MoreHorizontal, Plus, Search, Tag, User, X, Columns3 } from 'lucide-react';
import { ISSUE_ASSIGNABLE_AGENTS, ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueRunView, type IssueView } from '@slopus/happy-wire';
import { BackButton } from '@/app/BackButton';
import { ActionContextMenu, ActionDropdownMenu, EmptyState, Segmented, Spinner, type MenuItemDef } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useProjects } from '@/sync/projects';
import { importLegacyTodosOnce, loadIssues, updateIssue, useIssuesAvailability, useIssuesStore } from '@/sync/issuesStore';
import { useIssuesSync } from '@/sync/issuesSync';
import { toast } from '@/ui';
import {
    columnOf, failedRunsNeedingYou, filterActive, filterFromSearch, filterToSearch, groupByStatus, isClosedColumn, matchesFilter,
    myIssues, OTHER_STATUS, runsOfIssue, sortOrderBetween, usedLabels, type IssueColumn, type IssueFilter, type MyIssuesTab,
} from './issuesModel';
import { assigneeText, dueText, issuePath, PriorityTag, RunIndicator, StatusGlyph, useIssuesBase, useMachineNames } from './IssueParts';
import { NewIssueDialog } from './IssueDialogs';
import { IssueDecisions } from './IssueDecisions';
import { useIssuesCopy, type IssuesCopy } from './issuesCopy';
import { issueErrorText } from './issueErrors';
import './issues.css';

type View = 'list' | 'board';
type Tab = 'all' | MyIssuesTab;
const VIEW_KEY = 'vh.issues.view';
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; } };

export function IssuesScreen() {
    const copy = useIssuesCopy();
    const { lang } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const base = useIssuesBase();
    const availability = useIssuesAvailability();
    useIssuesSync(availability === 'enabled');
    useEffect(() => { if (availability === 'enabled') importLegacyTodosOnce(); }, [availability]);
    const issuesMap = useIssuesStore((s) => s.issues);
    const runs = useIssuesStore((s) => s.runs);
    const listStatus = useIssuesStore((s) => s.listStatus);
    const projects = useProjects();
    const machineName = useMachineNames();
    const params = new URLSearchParams(location.search);
    const filter = useMemo(() => filterFromSearch(location.search), [location.search]);
    const tab = (['assigned', 'waiting', 'created'].includes(params.get('tab') ?? '') ? params.get('tab') : 'all') as Tab;
    const [view, setViewState] = useState<View>(readView);
    const setView = (next: View) => { setViewState(next); try { localStorage.setItem(VIEW_KEY, next); } catch { /* private mode */ } };
    const [creating, setCreating] = useState(false);
    const setFilter = (next: IssueFilter) => navigate({ search: filterToSearch(next, { tab: tab === 'all' ? null : tab }) }, { replace: true });
    const setTab = (next: Tab) => navigate({ search: filterToSearch(filter, { tab: next === 'all' ? null : next }) }, { replace: true });

    const all = useMemo(() => Object.values(issuesMap), [issuesMap]);
    const failedIssueIds = useMemo(() => new Set(failedRunsNeedingYou(runs, issuesMap).map((r) => r.issueId)), [runs, issuesMap]);
    const scoped = useMemo(() => (tab === 'all' ? all : myIssues(all, tab, failedIssueIds)), [all, tab, failedIssueIds]);
    const shown = useMemo(() => scoped.filter((i) => matchesFilter(i, filter)), [scoped, filter]);
    const runsBy = useMemo(() => {
        const map = new Map<string, IssueRunView[]>();
        for (const issue of all) map.set(issue.id, runsOfIssue(runs, issue.id));
        return map;
    }, [all, runs]);
    const projectName = (id: string | null) => (id ? projects.projects.find((p) => p.id === id)?.name ?? null : null);

    if (availability === 'disabled') {
        return <main className="is-screen"><header className="is-head"><div className="vh-back-row"><BackButton /><h1>{copy.title}</h1></div></header><p className="is-muted">{copy.disabled}</p></main>;
    }
    const tabs: { value: Tab; label: string }[] = [
        { value: 'all', label: copy.all }, { value: 'assigned', label: copy.assigned }, { value: 'waiting', label: copy.waiting }, { value: 'created', label: copy.created },
    ];
    const rowProps = { copy, base, lang, runsBy, machineName, projectName };
    return (
        <main className="is-screen" data-testid="issues-screen">
            <header className="is-head">
                <div className="vh-back-row"><BackButton /><h1><ListTodo size={22} aria-hidden />{copy.title}</h1></div>
                <div className="is-head-actions">
                    <Link className="is-ghost" to={`${base}/issues/external`}><ExternalLink size={14} aria-hidden />{copy.external}</Link>
                    <Segmented className="is-view-switch" label={copy.view} value={view} onChange={setView} options={[{ value: 'list', label: copy.list, icon: LayoutList }, { value: 'board', label: copy.board, icon: Columns3 }]} />
                    <button type="button" className="is-primary" onClick={() => setCreating(true)} data-testid="issues-new"><Plus size={14} aria-hidden />{copy.newIssue}</button>
                </div>
            </header>
            <nav className="is-tabs vh-segmented" aria-label={copy.scope}>
                {tabs.map((t) => <button key={t.value} type="button" aria-pressed={tab === t.value} onClick={() => setTab(t.value)}>{t.label}</button>)}
            </nav>
            <FilterBar filter={filter} onChange={setFilter} copy={copy} issues={all} projects={projects.projects} />
            {tab === 'waiting' && <IssueDecisions />}
            {listStatus === 'loading' || availability === 'unknown'
                ? <p className="is-muted is-loading"><Spinner size={14} /> {copy.loading}</p>
                : listStatus === 'error' ? <p className="is-muted">{copy.loadFailed} <button type="button" className="is-ghost" onClick={() => void loadIssues({ full: true })}>{copy.retry}</button></p>
                    : shown.length === 0 && tab === 'all'
                        ? <EmptyState compact title={filterActive(filter) ? copy.emptyFiltered : copy.empty} description={filterActive(filter) ? undefined : copy.emptyHint}
                            actions={filterActive(filter) ? <button type="button" className="is-ghost" onClick={() => setFilter({ ...filter, status: [], projectId: [], assignee: [], label: [], priority: [], q: '' })}>{copy.clear}</button>
                                : <button type="button" className="is-primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden />{copy.newIssue}</button>} />
                        : view === 'board' ? <IssueBoard issues={shown} {...rowProps} /> : <IssueList issues={shown} {...rowProps} />}
            <p className="is-muted is-server-note">{copy.serverVisible}</p>
            {creating && <NewIssueDialog onClose={() => setCreating(false)} initialProjectId={filter.projectId.length === 1 && filter.projectId[0] !== 'none' ? filter.projectId[0] : null} />}
        </main>
    );
}

// ─── filters ──────────────────────────────────────────────────────────────────

function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function FilterBar({ filter, onChange, copy, issues, projects }: {
    filter: IssueFilter; onChange: (f: IssueFilter) => void; copy: IssuesCopy; issues: IssueView[]; projects: { id: string; name: string; archivedAt?: number | null }[];
}) {
    const labels = useMemo(() => usedLabels(issues), [issues]);
    const chip = (key: keyof Omit<IssueFilter, 'q'>, label: string, Icon: typeof Tag, options: { value: string; label: string }[]) => {
        const selected = filter[key];
        const items: MenuItemDef[] = options.map((o) => ({ key: o.value, label: o.label, icon: Icon, checked: selected.includes(o.value), onSelect: () => onChange({ ...filter, [key]: toggle(selected, o.value) }) }));
        const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
        return (
            <ActionDropdownMenu key={key} align="start" items={items.length ? items : [{ key: 'none', label: '—', icon: Icon, disabled: true, onSelect: () => {} }]}>
                <button type="button" className={`is-chip${selected.length ? ' is-on' : ''}`} data-filter={key} aria-label={names.length ? `${label}: ${names.join(', ')}` : label}>
                    <Icon size={13} aria-hidden /><span>{names.length ? (names.length === 1 ? names[0] : `${label} · ${names.length}`) : label}</span><ChevronDown size={12} aria-hidden />
                </button>
            </ActionDropdownMenu>
        );
    };
    return (
        <div className="is-filters" role="group" aria-label={copy.filters}>
            <label className="is-search">
                <Search size={14} aria-hidden />
                <input value={filter.q} placeholder={copy.search} aria-label={copy.search} onChange={(e) => onChange({ ...filter, q: e.target.value })} />
            </label>
            {chip('status', copy.status, CircleDot, [...ISSUE_STATUSES, OTHER_STATUS].map((s) => ({ value: s, label: copy.statuses[s] })))}
            {chip('projectId', copy.project, FolderKanban, [{ value: 'none', label: copy.noProject }, ...projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name }))])}
            {chip('assignee', copy.assignee, User, [{ value: 'none', label: copy.none }, { value: 'self', label: copy.self }, ...ISSUE_ASSIGNABLE_AGENTS.map((a) => ({ value: `agent:${a}`, label: a }))])}
            {chip('label', copy.label, Tag, labels.map((l) => ({ value: l, label: l })))}
            {chip('priority', copy.priority, Flag, ISSUE_PRIORITIES.map((p) => ({ value: p, label: copy.priorities[p] })))}
            {filterActive(filter) && <button type="button" className="is-ghost" onClick={() => onChange({ status: [], projectId: [], assignee: [], label: [], priority: [], q: '' })}><X size={13} aria-hidden />{copy.clear}</button>}
        </div>
    );
}

// ─── rows ─────────────────────────────────────────────────────────────────────

interface RowProps {
    copy: IssuesCopy;
    base: string;
    lang: string;
    runsBy: Map<string, IssueRunView[]>;
    machineName: (id: string) => string;
    projectName: (id: string | null) => string | null;
}

export function statusMenuItems(issue: IssueView, copy: IssuesCopy, onError: (text: string) => void): MenuItemDef[] {
    return ISSUE_STATUSES.map((s, i) => ({
        key: s, label: copy.statuses[s], icon: CircleDot, checked: issue.status === s, separatorBefore: i === 0 ? false : undefined,
        onSelect: () => { if (issue.status !== s) void updateIssue(issue.id, { status: s }).catch((e) => onError(issueErrorText(e, copy))); },
    }));
}

export function IssueRow({ issue, copy, base, lang, runsBy, machineName, projectName, compact, liProps }: RowProps & { issue: IssueView; compact?: boolean; liProps?: LiHTMLAttributes<HTMLLIElement> }) {
    const navigate = useNavigate();
    const items = statusMenuItems(issue, copy, (text) => toast.error(text));
    const project = projectName(issue.projectId);
    const due = dueText(issue.dueAt, lang);
    return (
        <ActionContextMenu items={items} sheetTitle={`${issue.key} · ${copy.moveTo}`}>
            <li className="is-row" data-issue={issue.key} {...liProps}>
                <button type="button" className="is-row-main" onClick={() => navigate(issuePath(base, issue.key))}>
                    <StatusGlyph status={issue.status} />
                    <span className="is-key mono">{issue.key}</span>
                    <span className="is-row-title">{issue.title}</span>
                    <RunIndicator issue={issue} runs={runsBy.get(issue.id) ?? []} copy={copy} />
                    <span className="is-row-meta">
                        <PriorityTag priority={issue.priority} copy={copy} />
                        {!compact && issue.labels.slice(0, 3).map((l) => <span key={l} className="is-label">{l}</span>)}
                        {!compact && project && <span className="is-row-project">{project}</span>}
                        {issue.assignee.kind !== 'none' && <span className="is-row-assignee">{assigneeText(issue.assignee, copy, machineName)}</span>}
                        {due && <span className="is-row-due">{due}</span>}
                    </span>
                </button>
                <ActionDropdownMenu items={items} sheetTitle={`${issue.key} · ${copy.moveTo}`}>
                    <button type="button" className="is-row-act" aria-label={`${copy.moveTo}: ${issue.key}`} title={copy.moveTo}><MoreHorizontal size={16} /></button>
                </ActionDropdownMenu>
            </li>
        </ActionContextMenu>
    );
}

function IssueList({ issues, ...rest }: RowProps & { issues: IssueView[] }) {
    const groups = groupByStatus(issues).filter((g) => g.issues.length > 0);
    const [open, setOpen] = useState<Record<string, boolean>>({});
    return (
        <div className="is-list" data-testid="issues-list">
            {groups.map((g) => {
                const expanded = open[g.status] ?? !isClosedColumn(g.status);
                return (
                    <section key={g.status} className="is-group" data-status={g.status}>
                        <button type="button" className="is-group-head" aria-expanded={expanded} onClick={() => setOpen((s) => ({ ...s, [g.status]: !expanded }))}>
                            {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                            <StatusGlyph status={g.status} />
                            <span>{rest.copy.statuses[g.status]}</span>
                            <span className="is-count">{g.issues.length}</span>
                        </button>
                        {expanded && <ul className="is-rows">{g.issues.map((issue) => <IssueRow key={issue.id} issue={issue} {...rest} />)}</ul>}
                    </section>
                );
            })}
        </div>
    );
}

function IssueBoard({ issues, ...rest }: RowProps & { issues: IssueView[] }) {
    const groups = groupByStatus(issues).filter((g) => g.status !== OTHER_STATUS || g.issues.length > 0);
    const [dragId, setDragId] = useState<string | null>(null);
    const [over, setOver] = useState<IssueColumn | null>(null);
    const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);
    const drop = (status: IssueColumn, beforeId: string | null) => {
        const issue = dragId ? byId.get(dragId) : undefined;
        setDragId(null);
        setOver(null);
        if (!issue || status === OTHER_STATUS) return;
        const column = (groups.find((g) => g.status === status)?.issues ?? []).filter((i) => i.id !== issue.id);
        const at = beforeId ? column.findIndex((i) => i.id === beforeId) : column.length;
        const index = at < 0 ? column.length : at;
        const sortOrder = sortOrderBetween(column[index - 1]?.sortOrder, column[index]?.sortOrder);
        if (columnOf(issue.status) === status && sortOrder === issue.sortOrder) return;
        void updateIssue(issue.id, { ...(columnOf(issue.status) === status ? {} : { status }), sortOrder }).catch((e) => toast.error(issueErrorText(e, rest.copy)));
    };
    const allow = (e: DragEvent, status: IssueColumn) => { if (dragId) { e.preventDefault(); setOver(status); } };
    return (
        <div className="is-board" data-testid="issues-board">
            {groups.map((g) => (
                <section key={g.status} className={`is-col${over === g.status ? ' is-drop' : ''}`} data-status={g.status}
                    onDragOver={(e) => allow(e, g.status)} onDragLeave={() => setOver((o) => (o === g.status ? null : o))} onDrop={() => drop(g.status, null)}>
                    <header className="is-col-head"><StatusGlyph status={g.status} /><span>{rest.copy.statuses[g.status]}</span><span className="is-count">{g.issues.length}</span></header>
                    <ul className="is-col-cards">
                        {g.issues.map((issue) => (
                            <IssueRow key={issue.id} issue={issue} compact {...rest} liProps={{
                                draggable: true,
                                onDragStart: (e) => { setDragId(issue.id); e.dataTransfer.effectAllowed = 'move'; },
                                onDragEnd: () => { setDragId(null); setOver(null); },
                                onDrop: (e) => { e.stopPropagation(); drop(g.status, issue.id); },
                            }} />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

