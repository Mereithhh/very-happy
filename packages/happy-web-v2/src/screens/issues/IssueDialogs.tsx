/** B-873: 新建 issue and the assignee dialog (same `.ns-*` dialog shell as 新建会话). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueAssignee } from '@slopus/happy-wire';
import { Button, Combobox, SelectMenu, toast } from '@/ui';
import type { SelectOption } from '@/ui';
import { DialogHead } from '@/ui/DialogHead';
import { useImeGuard } from '@/utils/ime';
import { useProjects } from '@/sync/projects';
import { createIssue, loadIssueWorkers, useIssuesStore } from '@/sync/issuesStore';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { useB892 } from '@/screens/sessions/sidebarTopVariant';
import { defaultNewIssueAgent, readLastIssueAgent, writeLastIssueAgent } from './IssueGuide';
import { machineWorkerState } from './issuesModel';
import { AssigneeFields, assigneeToDraft, draftToAssignee, useAccountLabel, type AssigneeDraft } from './AssigneeFields';
import { issuePath, useIssuesBase } from './IssueParts';
import { useIssuesCopy, type IssuesCopy } from './issuesCopy';
import { issueErrorText } from './issueErrors';
import '@/screens/sessions/newsession.css';
import './issues.css';

export function statusOptions(copy: IssuesCopy): SelectOption[] {
    return ISSUE_STATUSES.map((s) => ({ value: s, label: copy.statuses[s] }));
}
export function priorityOptions(copy: IssuesCopy): SelectOption[] {
    return ISSUE_PRIORITIES.map((p) => ({ value: p, label: copy.priorities[p] }));
}
export function projectOptions(copy: IssuesCopy, projects: readonly { id: string; name: string; archivedAt?: number | null }[]): SelectOption[] {
    return [{ value: '', label: copy.noProject }, ...projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name }))];
}

export function NewIssueDialog({ onClose, initialTitle = '', initialProjectId = null }: { onClose: () => void; initialTitle?: string; initialProjectId?: string | null }) {
    const copy = useIssuesCopy();
    const navigate = useNavigate();
    const base = useIssuesBase();
    const projects = useProjects();
    const ime = useImeGuard();
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState('none');
    const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
    const [draft, setDraft] = useState<AssigneeDraft>(() => assigneeToDraft(undefined));
    // Default status follows the assignee (wire: todo for an agent, else backlog) until the user picks one.
    const [pickedStatus, setPickedStatus] = useState<string | null>(null);
    const status = pickedStatus ?? (draft.kind === 'agent' ? 'todo' : 'backlog');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestId = useRef(`new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const accountLabel = useAccountLabel(draft.machineId, draft.agent);
    useEffect(() => { void loadIssueWorkers(); }, []);
    // B-892 prototype: an online worker makes Agent the default (last choice remembered), shown as one
    // summary line; the primary button says it will run. Untouched drafts only; no worker = 无, as today.
    const improved = useB892((s) => s.issues);
    const machines = useAllMachines({ includeOffline: true });
    const workers = useIssuesStore((s) => s.workers);
    const [touched, setTouched] = useState(false);
    const [editAssignee, setEditAssignee] = useState(false);
    useEffect(() => {
        if (!improved || touched || workers === null) return;
        const now = Date.now();
        const pick = defaultNewIssueAgent(readLastIssueAgent(), machines.filter((m) => machineWorkerState({ online: isMachineOnline(m), machineId: m.id }, workers, now) === 'ok').map((m) => m.id));
        if (pick && (draft.kind !== 'agent' || draft.machineId !== pick.machineId)) setDraft({ ...draft, kind: 'agent', machineId: pick.machineId, agent: pick.agent });
    }, [improved, touched, workers, machines, draft]);
    const editDraft = (next: AssigneeDraft) => { setTouched(true); setDraft(next); };
    const summaryMachine = machines.find((m) => m.id === draft.machineId);
    const runsNow = draft.kind === 'agent' && status !== 'backlog';
    const assignee = draftToAssignee(draft, accountLabel);
    const canCreate = title.trim().length > 0 && assignee !== null && !busy;

    async function onCreate() {
        if (!canCreate || !assignee) { if (!title.trim()) setError(copy.titleRequired); return; }
        setBusy(true);
        setError(null);
        try {
            const issue = await createIssue({
                title: title.trim(),
                ...(description.trim() ? { description } : {}),
                status: status as never,
                priority: priority as never,
                assignee,
                ...(projectId ? { projectId } : {}),
                requestId: requestId.current,
            });
            if (improved && draft.kind === 'agent') writeLastIssueAgent({ machineId: draft.machineId, agent: draft.agent });
            onClose();
            navigate(issuePath(base, issue.key));
        } catch (e) {
            setError(issueErrorText(e, copy));
            setBusy(false);
        }
    }

    return (
        <div className="ns-backdrop vh-dialog-overlay" onClick={onClose}>
            <div className="ns-card vh-dialog vh-dialog--tall" role="dialog" aria-modal="true" aria-labelledby="is-new-title" onClick={(e) => e.stopPropagation()} data-testid="new-issue-dialog"
                onKeyDown={(e) => { if (improved && !e.defaultPrevented && !ime.isGuarded(e) && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void onCreate(); } }}>
                <DialogHead title={copy.newTitle} titleId="is-new-title" onClose={onClose} />
                <input className="ns-input is-new-title-input" value={title} placeholder={copy.titlePh} aria-label={copy.titlePh} autoFocus maxLength={300}
                    onChange={(e) => setTitle(e.target.value)}
                    onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(e) => { if (ime.isGuarded(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onCreate(); } }} />
                <textarea className="ns-input ns-initial" rows={3} value={description} placeholder={copy.descriptionPh} aria-label={copy.description}
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => { if (ime.isGuarded(e)) return; if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void onCreate(); } }} />
                <div className="is-new-row">
                    <SelectMenu label={copy.status} value={status} options={statusOptions(copy)} onChange={setPickedStatus} variant="chip" />
                    <SelectMenu label={copy.priority} value={priority} options={priorityOptions(copy)} onChange={setPriority} variant="chip" />
                    {projects.status === 'ready' && <Combobox label={copy.project} value={projectId} options={projectOptions(copy, projects.projects)} onChange={setProjectId} variant="chip" />}
                </div>
                <label className="ns-label">{copy.assignee}</label>
                {improved && draft.kind === 'agent' && !editAssignee && summaryMachine
                    ? <div className="is-assignee-summary" data-testid="issue-assignee-summary">
                        <span className="is-assignee-summary-who">{copy.assignedTo(draft.agent, machineLabel(summaryMachine))}</span>
                        <button type="button" className="is-ghost" onClick={() => { setTouched(true); setEditAssignee(true); }}>{copy.change}</button>
                    </div>
                    : <AssigneeFields draft={draft} onChange={editDraft} copy={copy} status={status} projectId={projectId || null} idPrefix="is-new" />}
                {improved && <p className="is-muted is-server-note is-new-trust">{copy.serverVisible}</p>}
                {error && <div className="nwt-error" role="alert">{error}</div>}
                <div className="ns-actions vh-dialog-foot">
                    {improved && <span className="is-muted is-submit-hint">{copy.submitHint}</span>}
                    <Button variant="ghost" onClick={onClose}>{copy.cancel}</Button>
                    <Button variant="primary" disabled={!canCreate} loading={busy} onClick={() => { void onCreate(); }} data-testid="new-issue-create">{improved && runsNow ? copy.createAndRun : copy.create}</Button>
                </div>
            </div>
        </div>
    );
}

export function AssigneeDialog({ value, status, projectId, onApply, onClose }: {
    value: Parameters<typeof assigneeToDraft>[0];
    status: string;
    projectId: string | null;
    onApply: (assignee: IssueAssignee) => Promise<void>;
    onClose: () => void;
}) {
    const copy = useIssuesCopy();
    const [draft, setDraft] = useState<AssigneeDraft>(() => assigneeToDraft(value));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const accountLabel = useAccountLabel(draft.machineId, draft.agent);
    useEffect(() => { void loadIssueWorkers(); }, []);
    const assignee = useMemo(() => draftToAssignee(draft, accountLabel), [draft, accountLabel]);
    const apply = async () => {
        if (!assignee) return;
        setBusy(true);
        setError(null);
        try { await onApply(assignee); onClose(); } catch (e) { setError(issueErrorText(e, copy)); setBusy(false); }
    };
    return (
        <div className="ns-backdrop vh-dialog-overlay" onClick={onClose}>
            <div className="ns-card vh-dialog" role="dialog" aria-modal="true" aria-labelledby="is-assign-title" onClick={(e) => e.stopPropagation()} data-testid="assignee-dialog">
                <DialogHead title={copy.assignTitle} titleId="is-assign-title" onClose={onClose} />
                <AssigneeFields draft={draft} onChange={setDraft} copy={copy} status={status} projectId={projectId} idPrefix="is-assign" />
                {error && <div className="nwt-error" role="alert">{error}</div>}
                <div className="ns-actions vh-dialog-foot">
                    <Button variant="ghost" onClick={onClose}>{copy.cancel}</Button>
                    <Button variant="primary" disabled={!assignee || busy} loading={busy} onClick={() => { void apply(); }} data-testid="assignee-apply">{copy.apply}</Button>
                </div>
            </div>
        </div>
    );
}

/** One-line confirmation after an action whose result shows elsewhere. */
export function toastDone(text: string): void {
    toast.success(text);
}
