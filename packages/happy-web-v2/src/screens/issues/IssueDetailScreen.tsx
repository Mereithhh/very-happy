/**
 * B-873 `/issues/:key` (spec §10 详情): title and description (Markdown,
 * explicit save, `ifVersion` conflict reloads the latest), the property rail
 * (状态 / 优先级 / 指派 — the new-session picker / 项目 / 标签 / 截止 / 父
 * issue), the runs list (第 N 次 · trigger · agent·机器 · 状态 · 时长, opens
 * the session; 重试 / 换 agent / 停止), and the timeline with the comment box
 * (structured `@agent`, `/note`, and a preview of what posting will wake).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowUpRight, AtSign, Check, CornerUpLeft, MoreHorizontal, RotateCw, Square, Trash2, UserRoundCog, X } from 'lucide-react';
import { isIssueRunActive, ISSUE_LIMITS, type IssueCommentView, type IssueRunView, type IssueView } from '@slopus/happy-wire';
import { BackButton } from '@/app/BackButton';
import { Modal } from '@/modal';
import { ActionDropdownMenu, Combobox, SelectMenu, Spinner, toast, type MenuItemDef } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { useProjects } from '@/sync/projects';
import { IssuesApiError } from '@/sync/apiIssues';
import {
    acceptIssue, cancelIssueRun, commentOnIssue, deleteIssue, loadIssueDetail, startIssueRun, updateIssue, useIssuesAvailability, useIssuesStore,
} from '@/sync/issuesStore';
import { useIssuesSync } from '@/sync/issuesSync';
import { Markdown } from '@/screens/session/Markdown';
import {
    agentIdleStillInProgress, commentTriggerPreview, mentionQuery, type AgentMention, findIssue, formatDuration, mentionCandidates, runDurationMs, runsOfIssue, toggleMention, type TriggerPreview,
} from './issuesModel';
import { assigneeText, issuePath, sessionPath, StatusGlyph, useIssuesBase, useMachineNames } from './IssueParts';
import { AssigneeDialog, priorityOptions, projectOptions, statusOptions } from './IssueDialogs';
import { confirmReturn } from './IssueDecisions';
import { useIssuesCopy, type IssuesCopy } from './issuesCopy';
import { issueErrorText } from './issueErrors';
import './issues.css';

export function IssueDetailScreen() {
    const { key = '' } = useParams();
    const copy = useIssuesCopy();
    const availability = useIssuesAvailability();
    useIssuesSync(availability === 'enabled');
    const issue = useIssuesStore((s) => findIssue(s.issues, key));
    const detail = useIssuesStore((s) => (issue ? s.details[issue.id] : undefined) ?? s.details[key]);
    useEffect(() => { if (availability === 'enabled') void loadIssueDetail(key); }, [availability, key]);
    if (availability === 'disabled') return <main className="is-screen"><div className="vh-back-row"><BackButton /></div><p className="is-muted">{copy.disabled}</p></main>;
    if (!issue || issue.deletedAt) {
        const missing = detail?.status === 'missing' || issue?.deletedAt;
        return <main className="is-screen"><div className="vh-back-row"><BackButton /></div><p className="is-muted">{missing ? copy.notFound : <><Spinner size={14} /> {copy.loading}</>}</p></main>;
    }
    return <IssueDetail issue={issue} comments={detail?.comments ?? {}} children={detail?.children ?? []} />;
}

function IssueDetail({ issue, comments, children }: { issue: IssueView; comments: Record<string, IssueCommentView>; children: { id: string; key: string; title: string; status: string }[] }) {
    const copy = useIssuesCopy();
    const navigate = useNavigate();
    const base = useIssuesBase();
    const runsMap = useIssuesStore((s) => s.runs);
    const runs = useMemo(() => runsOfIssue(runsMap, issue.id), [runsMap, issue.id]);
    const machineName = useMachineNames();
    const [busy, setBusy] = useState<string | null>(null);
    const guard = async (k: string, work: () => Promise<unknown>, done?: string) => {
        if (busy) return;
        setBusy(k);
        try { await work(); if (done) toast.success(done); } catch (e) { toast.error(issueErrorText(e, copy)); } finally { setBusy(null); }
    };
    const menu: MenuItemDef[] = [{
        key: 'delete', label: copy.delete, icon: Trash2, danger: true,
        onSelect: () => void (async () => {
            if (!(await Modal.confirm(copy.delete, copy.deleteConfirm, { destructive: true, confirmText: copy.delete, cancelText: copy.cancel }))) return;
            await guard('delete', () => deleteIssue(issue.id), copy.deleted);
            navigate(`${base}/issues`);
        })(),
    }];
    return (
        <main className="is-screen is-detail" data-testid="issue-detail" data-issue={issue.key}>
            <header className="is-head">
                <div className="vh-back-row"><BackButton /><span className="is-key mono">{issue.key}</span><StatusGlyph status={issue.status} /><span className="is-muted">{copy.statuses[issue.status] ?? issue.status}</span></div>
                <ActionDropdownMenu items={menu}><button type="button" className="is-icon-btn" aria-label={copy.more} title={copy.more}><MoreHorizontal size={16} /></button></ActionDropdownMenu>
            </header>
            <TitleEditor issue={issue} copy={copy} />
            {issue.status === 'in_review' && (
                <div className="is-review-bar" data-testid="issue-review-bar">
                    <span>{issue.key} · {copy.statuses.in_review}</span>
                    <span className="is-dec-acts">
                        <button type="button" className="is-primary" disabled={!!busy} onClick={() => void guard('done', () => acceptIssue(issue.id), copy.accepted)}><Check size={14} aria-hidden />{copy.accept}</button>
                        <button type="button" className="is-soft" disabled={!!busy} onClick={() => void guard('ret', async () => { if (await confirmReturn(issue, copy)) toast.success(copy.rejected); })}><CornerUpLeft size={14} aria-hidden />{copy.reject}</button>
                    </span>
                </div>
            )}
            {agentIdleStillInProgress(issue, runs) && <p className="is-idle-banner" data-testid="issue-idle-still"><span className="is-idle-still">{copy.idleStill}</span> {copy.idleStillHint}</p>}
            <div className="is-detail-grid">
                <div className="is-detail-main">
                    <DescriptionEditor issue={issue} copy={copy} />
                    {children.length > 0 && (
                        <section className="is-section"><h2>{copy.children}</h2>
                            <ul className="is-rows">{children.map((c) => <li key={c.id} className="is-row"><Link className="is-row-main" to={issuePath(base, c.key)}><StatusGlyph status={c.status} /><span className="is-key mono">{c.key}</span><span className="is-row-title">{c.title}</span></Link></li>)}</ul>
                        </section>
                    )}
                    <RunsSection issue={issue} runs={runs} copy={copy} machineName={machineName} />
                    <Timeline issue={issue} comments={comments} runs={runs} copy={copy} machineName={machineName} />
                    <CommentBox issue={issue} runs={runs} copy={copy} machineName={machineName} />
                </div>
                <aside className="is-detail-side" aria-label={copy.fields}>
                    <FieldsPanel issue={issue} copy={copy} machineName={machineName} />
                </aside>
            </div>
            <p className="is-muted is-server-note">{copy.serverVisible}</p>
        </main>
    );
}

function TitleEditor({ issue, copy }: { issue: IssueView; copy: IssuesCopy }) {
    const [value, setValue] = useState(issue.title);
    const ime = useImeGuard();
    useEffect(() => { setValue(issue.title); }, [issue.title]);
    const save = () => {
        const next = value.trim();
        if (!next || next === issue.title) { setValue(issue.title); return; }
        void updateIssue(issue.id, { title: next }).catch((e) => { toast.error(issueErrorText(e, copy)); setValue(issue.title); });
    };
    return <input className="is-title-input" value={value} aria-label={copy.titlePh} maxLength={ISSUE_LIMITS.titleChars}
        onChange={(e) => setValue(e.target.value)} onBlur={save}
        onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={(e) => { if (ime.isGuarded(e)) return; if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setValue(issue.title); } }} />;
}

function DescriptionEditor({ issue, copy }: { issue: IssueView; copy: IssuesCopy }) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(issue.description);
    const [baseVersion, setBaseVersion] = useState(issue.version);
    const [saving, setSaving] = useState(false);
    const [conflict, setConflict] = useState(false);
    const start = () => { setText(issue.description); setBaseVersion(issue.version); setConflict(false); setEditing(true); };
    const save = async () => {
        setSaving(true);
        try {
            await updateIssue(issue.id, { description: text, ifVersion: baseVersion });
            setEditing(false);
            setConflict(false);
        } catch (e) {
            if (e instanceof IssuesApiError && e.code === 'issue_version_conflict') {
                const latest = (e.details?.issue as IssueView | undefined) ?? (await loadIssueDetail(issue.id));
                if (latest) { setText(latest.description); setBaseVersion(latest.version); }
                setConflict(true);
            } else toast.error(issueErrorText(e, copy));
        } finally { setSaving(false); }
    };
    return (
        <section className="is-section is-desc">
            <div className="is-section-head"><h2>{copy.description}</h2>{!editing && <button type="button" className="is-ghost" onClick={start} data-testid="issue-desc-edit">{copy.edit}</button>}</div>
            {editing ? (
                <>
                    {conflict && <p className="is-warn" role="alert">{copy.conflict}</p>}
                    <textarea className="is-textarea" value={text} rows={8} placeholder={copy.descriptionPh} aria-label={copy.description} autoFocus onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void save(); } }} />
                    <div className="is-editor-acts">
                        <button type="button" className="is-ghost" onClick={() => setEditing(false)}>{copy.cancel}</button>
                        <button type="button" className="is-primary" disabled={saving} aria-busy={saving} onClick={() => void save()} data-testid="issue-desc-save">{copy.save}</button>
                    </div>
                </>
            ) : issue.description.trim() ? <div className="is-markdown"><Markdown text={issue.description} /></div> : <button type="button" className="is-desc-empty" onClick={start}>{copy.descriptionPh}</button>}
        </section>
    );
}

function FieldsPanel({ issue, copy, machineName }: { issue: IssueView; copy: IssuesCopy; machineName: (id: string) => string }) {
    const { lang } = useTranslation();
    const projects = useProjects();
    const allIssues = useIssuesStore((s) => s.issues);
    const [assigning, setAssigning] = useState(false);
    const [labelDraft, setLabelDraft] = useState('');
    const ime = useImeGuard();
    const patch = (input: Parameters<typeof updateIssue>[1]) => void updateIssue(issue.id, input).catch((e) => toast.error(issueErrorText(e, copy)));
    const parentOptions = useMemo(() => [{ value: '', label: copy.none }, ...Object.values(allIssues).filter((i) => !i.deletedAt && i.id !== issue.id).sort((a, b) => b.number - a.number).map((i) => ({ value: i.id, label: `${i.key} ${i.title}` }))], [allIssues, issue.id, copy]);
    const addLabel = () => {
        const label = labelDraft.trim().slice(0, ISSUE_LIMITS.labelChars);
        setLabelDraft('');
        if (!label || issue.labels.includes(label) || issue.labels.length >= ISSUE_LIMITS.labels) return;
        patch({ labels: [...issue.labels, label] });
    };
    const dueValue = issue.dueAt ? new Date(issue.dueAt).toISOString().slice(0, 10) : '';
    return (
        <dl className="is-fields" data-lang={lang}>
            <dt id="is-f-status">{copy.status}</dt>
            <dd><SelectMenu label={copy.status} labelledBy="is-f-status" value={issue.status} options={statusOptions(copy)} variant="soft" onChange={(status) => patch({ status: status as never })} /></dd>
            <dt id="is-f-priority">{copy.priority}</dt>
            <dd><SelectMenu label={copy.priority} labelledBy="is-f-priority" value={issue.priority} options={priorityOptions(copy)} variant="soft" onChange={(priority) => patch({ priority: priority as never })} /></dd>
            <dt>{copy.assignee}</dt>
            <dd><button type="button" className="is-field-btn" onClick={() => setAssigning(true)} data-testid="issue-assignee">{assigneeText(issue.assignee, copy, machineName)}</button></dd>
            {projects.status === 'ready' && <>
                <dt id="is-f-project">{copy.project}</dt>
                <dd><Combobox label={copy.project} labelledBy="is-f-project" value={issue.projectId ?? ''} options={projectOptions(copy, projects.projects)} variant="soft" onChange={(id) => patch({ projectId: id || null })} /></dd>
            </>}
            <dt>{copy.labels}</dt>
            <dd className="is-labels">
                {issue.labels.map((l) => <span key={l} className="is-label">{l}<button type="button" className="is-label-x vh-hit" aria-label={`${copy.cancel}: ${l}`} onClick={() => patch({ labels: issue.labels.filter((x) => x !== l) })}><X size={11} /></button></span>)}
                <input className="is-label-input" value={labelDraft} placeholder={copy.labelPh} aria-label={copy.addLabel} onChange={(e) => setLabelDraft(e.target.value)}
                    onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(e) => { if (ime.isGuarded(e)) return; if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }} onBlur={addLabel} />
            </dd>
            <dt><label htmlFor="is-f-due">{copy.due}</label></dt>
            <dd><input id="is-f-due" type="date" className="is-date" value={dueValue} onChange={(e) => patch({ dueAt: e.target.value ? Date.parse(`${e.target.value}T00:00:00Z`) : null })} /></dd>
            <dt id="is-f-parent">{copy.parent}</dt>
            <dd><Combobox label={copy.parent} labelledBy="is-f-parent" value={issue.parentId ?? ''} options={parentOptions} variant="soft" onChange={(id) => patch({ parentId: id || null })} /></dd>
            {assigning && <AssigneeDialog value={issue.assignee} status={issue.status} projectId={issue.projectId} onClose={() => setAssigning(false)}
                onApply={async (assignee) => { await updateIssue(issue.id, { assignee }); }} />}
        </dl>
    );
}

function RunsSection({ issue, runs, copy, machineName }: { issue: IssueView; runs: IssueRunView[]; copy: IssuesCopy; machineName: (id: string) => string }) {
    const base = useIssuesBase();
    const navigate = useNavigate();
    const [switching, setSwitching] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { if (!runs.some((r) => r.status === 'running')) return; const id = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(id); }, [runs]);
    const run = (work: () => Promise<unknown>) => void work().catch((e) => toast.error(issueErrorText(e, copy)));
    return (
        <section className="is-section" data-testid="issue-runs">
            <div className="is-section-head"><h2>{copy.runs}</h2></div>
            {runs.length === 0 ? <p className="is-muted">{copy.noRuns}</p> : (
                <ul className="is-runs">
                    {runs.map((r) => {
                        const waiting = (r.status === 'queued' || r.status === 'claimed') ? copy.waitingMachine(machineName(r.machineId)) : null;
                        return (
                            <li key={r.id} className={`is-run is-run--${r.status}`} data-run-status={r.status}>
                                <button type="button" className="is-run-main" disabled={!r.sessionId} onClick={() => r.sessionId && navigate(sessionPath(base, r.sessionId))} title={r.sessionId ? copy.openSession : undefined}>
                                    <span className="is-run-n">{copy.runN(r.seq)}</span>
                                    <span className="is-run-trigger">{copy.triggers[r.trigger] ?? r.trigger}</span>
                                    <span className="is-run-who">{copy.agentOn(r.agent, machineName(r.machineId))}</span>
                                    <span className={`is-run-status${r.status === 'running' ? ' is-live' : ''}${r.status === 'failed' ? ' is-err' : ''}`}>{r.status === 'running' && <Spinner size={11} />}{copy.runStatus[r.status] ?? r.status}</span>
                                    <span className="is-run-dur">{formatDuration(runDurationMs(r, now))}</span>
                                    {r.sessionId && <ArrowUpRight size={14} aria-hidden className="is-run-open" />}
                                </button>
                                {(waiting || r.error) && <span className="is-run-note">{r.error ?? waiting}</span>}
                                <span className="is-run-acts">
                                    {isIssueRunActive(r.status) && <button type="button" className="is-ghost" onClick={() => run(() => cancelIssueRun(r.id))}><Square size={12} aria-hidden />{copy.stop}</button>}
                                    {r.status === 'failed' && <>
                                        <button type="button" className="is-ghost" onClick={() => run(() => startIssueRun(issue.id, {}))}><RotateCw size={12} aria-hidden />{copy.retryRun}</button>
                                        <button type="button" className="is-ghost" onClick={() => setSwitching(true)}><UserRoundCog size={12} aria-hidden />{copy.switchAgent}</button>
                                    </>}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
            {switching && <AssigneeDialog value={issue.assignee} status={issue.status} projectId={issue.projectId} onClose={() => setSwitching(false)}
                onApply={async (assignee) => { if (assignee.kind === 'agent') await startIssueRun(issue.id, { assignee, reassign: true }); else await updateIssue(issue.id, { assignee }); }} />}
        </section>
    );
}

function authorLine(c: IssueCommentView, runs: IssueRunView[], copy: IssuesCopy, machineName: (id: string) => string): string {
    if (c.author.kind === 'user') return copy.you;
    if (c.author.kind === 'import') return copy.imported;
    if (c.author.kind === 'agent') {
        const run = runs.find((r) => r.id === c.author.runId);
        return run ? copy.agentRun(run.agent, machineName(run.machineId), run.seq) : 'agent';
    }
    return copy.system;
}

function systemLine(c: IssueCommentView, runs: IssueRunView[], copy: IssuesCopy): string {
    const data = c.data ?? {};
    if (c.kind === 'status' && typeof data.from === 'string' && typeof data.to === 'string') return copy.statusLine(copy.statuses[data.from] ?? data.from, copy.statuses[data.to] ?? data.to);
    if (c.kind === 'assign') return copy.assignLine;
    if (c.kind === 'run' && typeof data.runId === 'string') {
        const run = runs.find((r) => r.id === data.runId);
        if (run) return typeof data.error === 'string' ? `${copy.runFailed(run.seq)} — ${data.error}` : copy.runQueued(run.seq);
    }
    if (c.kind === 'field') return copy.fieldLine;
    return c.body;
}

function Timeline({ issue, comments, runs, copy, machineName }: { issue: IssueView; comments: Record<string, IssueCommentView>; runs: IssueRunView[]; copy: IssuesCopy; machineName: (id: string) => string }) {
    const base = useIssuesBase();
    const list = useMemo(() => Object.values(comments).filter((c) => !c.deletedAt && c.issueId === issue.id).sort((a, b) => a.createdAt - b.createdAt), [comments, issue.id]);
    const time = (ts: number) => { try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
    return (
        <section className="is-section" data-testid="issue-timeline">
            <div className="is-section-head"><h2>{copy.timeline}</h2></div>
            <ol className="is-timeline">
                {list.map((c) => {
                    if (c.kind !== 'comment') return <li key={c.id} className="is-tl-system"><span>{systemLine(c, runs, copy)}</span><span className="is-tl-time">{time(c.createdAt)}</span></li>;
                    const run = c.author.kind === 'agent' ? runs.find((r) => r.id === c.author.runId) : undefined;
                    const note = c.author.kind === 'user' && /^\/note(\s|$)/.test(c.body.trimStart());
                    const routed = c.routedRunIds.map((id) => runs.find((r) => r.id === id)?.seq).filter((n): n is number => typeof n === 'number');
                    return (
                        <li key={c.id} className={`is-tl-comment is-tl--${c.author.kind}`} data-author={c.author.kind}>
                            <div className="is-tl-head">
                                {run?.sessionId ? <Link to={sessionPath(base, run.sessionId)} className="is-tl-author">{authorLine(c, runs, copy, machineName)}</Link> : <span className="is-tl-author">{authorLine(c, runs, copy, machineName)}</span>}
                                {note && <span className="is-tl-tag">{copy.noteTag}</span>}
                                {c.mentions.filter((m) => m.kind === 'agent').map((m, i) => <span key={i} className="is-tl-tag">@{m.agent}</span>)}
                                {c.mentions.some((m) => m.kind === 'owner') && <span className="is-tl-tag is-tl-owner">{copy.ownerMention}</span>}
                                <span className="is-tl-time">{time(c.createdAt)}</span>
                            </div>
                            <div className="is-markdown"><Markdown text={c.body} /></div>
                            {routed.length > 0 && <div className="is-tl-routed">{routed.length === 1 ? copy.delivered(routed[0]) : copy.deliveredMany(routed.length)}</div>}
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}

export function previewText(preview: TriggerPreview, copy: IssuesCopy, machineName: (id: string) => string): string | null {
    if (preview.kind === 'note') return copy.preview.note;
    if (preview.kind === 'none') return preview.reason === 'empty' ? null : preview.reason === 'inactive-status' ? copy.preview.inactive : copy.preview.noAgent;
    return preview.targets.map((t) => {
        const who = t.machineId ? copy.agentOn(t.agent, machineName(t.machineId)) : t.agent;
        return t.mode === 'message' ? copy.preview.message(who) : t.mode === 'absorbed' ? copy.preview.absorbed(who) : copy.preview.spawn(who);
    }).join('；');
}

function CommentBox({ issue, runs, copy, machineName }: { issue: IssueView; runs: IssueRunView[]; copy: IssuesCopy; machineName: (id: string) => string }) {
    const projects = useProjects();
    const [body, setBody] = useState('');
    const [mentions, setMentions] = useState<AgentMention[]>([]);
    const [sending, setSending] = useState(false);
    const ime = useImeGuard();
    const requestId = useRef('');
    const fallbackMachine = issue.projectId ? projects.projects.find((p) => p.id === issue.projectId)?.folders.find((f) => f.primary)?.machineId ?? null : null;
    const candidates = mentionCandidates(issue, fallbackMachine);
    const preview = commentTriggerPreview({ body, mentions, issue, runs });
    const hint = previewText(preview, copy, machineName);
    const mentionItems: MenuItemDef[] = candidates.map((m) => ({
        key: m.agent, label: `@${m.agent}${m.machineId ? ` · ${machineName(m.machineId)}` : ''}`,
        icon: AtSign, checked: mentions.some((x) => x.agent === m.agent), onSelect: () => setMentions((list) => toggleMention(list, m)),
    }));
    // Typing `@` (at the start or after a space) offers the agents inline; picking one makes a structured mention (spec §6: never parsed from prose).
    const at = mentionQuery(body);
    const suggestions = at === null ? [] : candidates.filter((m) => m.agent.startsWith(at.toLowerCase()) && !mentions.some((x) => x.agent === m.agent));
    const pickSuggestion = (m: AgentMention) => {
        setMentions((list) => toggleMention(list, m));
        setBody((text) => text.replace(/@\w*$/, ''));
    };
    const send = async () => {
        if (!body.trim() || sending) return;
        setSending(true);
        if (!requestId.current) requestId.current = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        try {
            await commentOnIssue(issue.id, { body: body.trim(), ...(mentions.length ? { mentions } : {}), requestId: requestId.current });
            setBody('');
            setMentions([]);
            requestId.current = '';
        } catch (e) { toast.error(issueErrorText(e, copy)); } finally { setSending(false); }
    };
    return (
        <div className="is-composer" data-testid="issue-comment-box">
            <textarea className="is-composer-input" value={body} rows={3} placeholder={copy.commentPh} aria-label={copy.comment}
                onChange={(e) => setBody(e.target.value)}
                onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => { if (ime.isGuarded(e)) return; if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); } }} />
            {suggestions.length > 0 && (
                <div className="is-mention-suggest" role="group" aria-label={copy.mention} data-testid="issue-mention-suggest">
                    {suggestions.map((m) => <button key={m.agent} type="button" className="is-soft" onMouseDown={(e) => e.preventDefault()} onClick={() => pickSuggestion(m)}>@{m.agent}{m.machineId ? ` · ${machineName(m.machineId)}` : ''}</button>)}
                </div>
            )}
            <div className="is-composer-bar">
                <ActionDropdownMenu align="start" items={mentionItems}>
                    <button type="button" className="is-soft" data-testid="issue-mention"><AtSign size={14} aria-hidden />{copy.mention}</button>
                </ActionDropdownMenu>
                {mentions.map((m) => (
                    <span key={m.agent} className="is-mention-chip">@{m.agent}<button type="button" className="is-label-x vh-hit" aria-label={`${copy.cancel}: @${m.agent}`} onClick={() => setMentions((list) => toggleMention(list, m))}><X size={11} /></button></span>
                ))}
                <span className="is-composer-spacer" />
                <button type="button" className="is-primary" disabled={!body.trim() || sending} aria-busy={sending} onClick={() => void send()} data-testid="issue-comment-send">{copy.send}</button>
            </div>
            {hint && <p className={`is-trigger-preview is-trigger--${preview.kind}`} data-testid="issue-trigger-preview" aria-live="polite">{hint}</p>}
        </div>
    );
}
