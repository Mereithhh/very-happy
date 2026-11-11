/** B-873: 新建 issue and the assignee dialog (same `.ns-*` dialog shell as 新建会话). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ISSUE_ASSIGNABLE_AGENTS, ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueAssignee } from '@slopus/happy-wire';
import { Button, Combobox, SelectMenu, toast } from '@/ui';
import type { SelectOption } from '@/ui';
import { DialogHead } from '@/ui/DialogHead';
import { useImeGuard } from '@/utils/ime';
import { useProjects } from '@/sync/projects';
import { createIssue, loadIssueWorkers, useIssuesStore } from '@/sync/issuesStore';
import { storage, useAllMachines } from '@/sync/storage';
import { IS_MAC } from '@/app/appChord';
import { isAgentOffered, resolveAgentAvailability } from '@/utils/agentAvailability';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { machineWorkerState } from './issuesModel';
import { defaultNewIssueAssignee, isCreateChord, projectFolderOn, readRememberedAssignee, rememberedFromCreate, writeRememberedAssignee } from './newIssueDefaults';
import { AssigneeFields, assigneeToDraft, draftToAssignee, useAccountLabel, type AssigneeDraft } from './AssigneeFields';
import { issuePath, useIssuesBase } from './IssueParts';
import { useIssuesCopy, type IssuesCopy } from './issuesCopy';
import { issueErrorText } from './issueErrors';
import '@/screens/sessions/newsession.css';
import './issues.css';
import { DialogBackdrop } from '@/ui/DialogBackdrop';

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
    const accountId = storage((s) => s.profile.id);
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

    // B-896: start from the last assignee created with, while it can run as-is (newIssueDefaults.ts);
    // re-evaluated on project change until the user edits the assignee.
    const machines = useAllMachines({ includeOffline: true });
    const workers = useIssuesStore((s) => s.workers);
    const remembered = useMemo(() => readRememberedAssignee(accountId), [accountId]);
    const projectFolders = useMemo(() => projects.projects.find((p) => p.id === projectId)?.folders ?? [], [projects.projects, projectId]);
    const [assigneeTouched, setAssigneeTouched] = useState(false);
    const [editingAssignee, setEditingAssignee] = useState(false);
    useEffect(() => {
        if (assigneeTouched || workers === null) return;
        const now = Date.now();
        const runnable = machines
            .filter((m) => machineWorkerState({ online: isMachineOnline(m), machineId: m.id }, workers, now) === 'ok')
            .map((m) => ({ machineId: m.id, agents: ISSUE_ASSIGNABLE_AGENTS.filter((a) => isAgentOffered(m.metadata, a) && resolveAgentAvailability(m.metadata, a).available) }));
        const pick = defaultNewIssueAssignee(remembered, { projectId, projectFolders, runnable });
        setDraft((current) => {
            const next = pick.kind === 'agent'
                ? { ...assigneeToDraft(undefined), kind: 'agent' as const, machineId: pick.machineId, agent: pick.agent, model: pick.model, directory: pick.directory }
                : { ...assigneeToDraft(undefined), kind: pick.kind };
            return JSON.stringify(next) === JSON.stringify(current) ? current : next;
        });
    }, [assigneeTouched, workers, machines, remembered, projectId, projectFolders]);
    const editDraft = (next: AssigneeDraft) => { setAssigneeTouched(true); setDraft(next); };
    const summaryMachine = !assigneeTouched && !editingAssignee && draft.kind === 'agent' ? machines.find((m) => m.id === draft.machineId) : undefined;
    // The server refuses an agent without a resolvable directory (issue_no_directory): say so here instead.
    const missingDirectory = draft.kind === 'agent' && !!draft.machineId && !draft.directory.trim() && !projectFolderOn(projectFolders, draft.machineId);
    const runsNow = draft.kind === 'agent' && status !== 'backlog';

    const assignee = draftToAssignee(draft, accountLabel);
    const canCreate = title.trim().length > 0 && assignee !== null && !missingDirectory && !busy;

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
            writeRememberedAssignee(accountId, rememberedFromCreate({ ...draft, projectId, projectFolders }));
            onClose();
            navigate(issuePath(base, issue.key));
        } catch (e) {
            setError(issueErrorText(e, copy));
            setBusy(false);
        }
    }

    return (
        <DialogBackdrop className="ns-backdrop vh-dialog-overlay" onClose={onClose}>
            <div className="ns-card vh-dialog vh-dialog--tall" role="dialog" aria-modal="true" aria-labelledby="is-new-title" onClick={(e) => e.stopPropagation()} data-testid="new-issue-dialog"
                onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => { if (e.defaultPrevented || ime.isGuarded(e) || !isCreateChord(e)) return; e.preventDefault(); void onCreate(); }}>
                <DialogHead title={copy.newTitle} titleId="is-new-title" onClose={onClose} />
                <input className="ns-input is-new-title-input" value={title} placeholder={copy.titlePh} aria-label={copy.titlePh} autoFocus maxLength={300}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => { if (ime.isGuarded(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void onCreate(); } }} />
                <textarea className="ns-input ns-initial" rows={3} value={description} placeholder={copy.descriptionPh} aria-label={copy.description}
                    onChange={(e) => setDescription(e.target.value)} />
                <div className="is-new-row">
                    <SelectMenu label={copy.status} value={status} options={statusOptions(copy)} onChange={setPickedStatus} variant="chip" />
                    <SelectMenu label={copy.priority} value={priority} options={priorityOptions(copy)} onChange={setPriority} variant="chip" />
                    {projects.status === 'ready' && <Combobox label={copy.project} value={projectId} options={projectOptions(copy, projects.projects)} onChange={setProjectId} variant="chip" />}
                </div>
                <label className="ns-label">{copy.assignee}</label>
                {summaryMachine
                    ? <div className="is-assignee-summary" data-testid="issue-assignee-summary">
                        <span className="is-assignee-summary-who">{copy.assigneeSummary(draft.model ? `${draft.agent} · ${draft.model}` : draft.agent, machineLabel(summaryMachine), draft.directory)}</span>
                        <button type="button" className="is-ghost" onClick={() => setEditingAssignee(true)} data-testid="issue-assignee-change">{copy.change}</button>
                    </div>
                    : <AssigneeFields draft={draft} onChange={editDraft} copy={copy} status={status} projectId={projectId || null} idPrefix="is-new" />}
                {missingDirectory && <p className="is-field-note is-field-note--warn" role="status" data-testid="issue-needs-directory">{copy.needsDirectory}</p>}
                <p className="is-muted is-server-note is-new-trust">{copy.serverVisible}</p>
                {error && <div className="nwt-error" role="alert">{error}</div>}
                <div className="ns-actions vh-dialog-foot">
                    <span className="is-muted is-submit-hint" aria-hidden>{IS_MAC ? copy.submitHint : copy.submitHintCtrl}</span>
                    <Button variant="ghost" onClick={onClose}>{copy.cancel}</Button>
                    <Button variant="primary" disabled={!canCreate} loading={busy} onClick={() => { void onCreate(); }} data-testid="new-issue-create">{runsNow ? copy.createAndRun : copy.create}</Button>
                </div>
            </div>
        </DialogBackdrop>
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
        <DialogBackdrop className="ns-backdrop vh-dialog-overlay" onClose={onClose}>
            <div className="ns-card vh-dialog" role="dialog" aria-modal="true" aria-labelledby="is-assign-title" onClick={(e) => e.stopPropagation()} data-testid="assignee-dialog">
                <DialogHead title={copy.assignTitle} titleId="is-assign-title" onClose={onClose} />
                <AssigneeFields draft={draft} onChange={setDraft} copy={copy} status={status} projectId={projectId} idPrefix="is-assign" />
                {error && <div className="nwt-error" role="alert">{error}</div>}
                <div className="ns-actions vh-dialog-foot">
                    <Button variant="ghost" onClick={onClose}>{copy.cancel}</Button>
                    <Button variant="primary" disabled={!assignee || busy} loading={busy} onClick={() => { void apply(); }} data-testid="assignee-apply">{copy.apply}</Button>
                </div>
            </div>
        </DialogBackdrop>
    );
}

/** One-line confirmation after an action whose result shows elsewhere. */
export function toastDone(text: string): void {
    toast.success(text);
}
