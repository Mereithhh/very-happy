/**
 * B-586 「在新 worktree 中」 fields for the new-session dialog: base branch,
 * new branch (generated, editable), location (follows the branch until edited)
 * and a one-line summary of what initialization will do (B-585).
 *
 * Capability: hidden behind `machine.metadata.worktreeVersion` (an old daemon
 * cannot serve `worktree-*`); a `Method not found` answer (downgraded daemon
 * whose metadata still says otherwise) shows the same upgrade hint.
 */
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Checkbox, Combobox, Spinner } from '@/ui';
import { worktreeInfo, type WorktreeInfo, type WorktreeRpcResult } from '@/sync/worktreeOps';
import { generateWorktreeBranch, isAbsoluteMachinePath, isPlausibleBranchName, worktreeLocationFor } from '@/utils/worktree';
import { worktreeCopy, worktreeErrorText } from './worktreeCopy';
import './worktree.css';

export interface WorktreeDraft {
    enabled: boolean;
    baseRef: string;
    branch: string;
    location: string;
    locationEdited: boolean;
}

export const EMPTY_WORKTREE_DRAFT: WorktreeDraft = { enabled: false, baseRef: '', branch: '', location: '', locationEdited: false };

export type WorktreeInfoState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; result: WorktreeRpcResult<WorktreeInfo> };

/** Debounced `worktree-info` for the selected machine + directory while the option is on. */
export function useWorktreeInfo(machineId: string, directory: string, active: boolean): WorktreeInfoState {
    const [state, setState] = useState<WorktreeInfoState>({ phase: 'idle' });
    useEffect(() => {
        if (!active || !machineId || !isAbsoluteMachinePath(directory)) { setState({ phase: 'idle' }); return; }
        let cancelled = false;
        setState({ phase: 'loading' });
        const timer = setTimeout(() => {
            void worktreeInfo(machineId, directory).then((result) => { if (!cancelled) setState({ phase: 'done', result }); });
        }, 400);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [machineId, directory, active]);
    return state;
}

/** Ready to submit: info loaded and the three fields look valid. */
export function worktreeDraftReady(draft: WorktreeDraft, info: WorktreeInfoState): boolean {
    if (!draft.enabled) return true;
    return info.phase === 'done' && info.result.ok && !!draft.baseRef && isPlausibleBranchName(draft.branch) && isAbsoluteMachinePath(draft.location.trim());
}

export function NewWorktreeFields({ lang, supported, draft, onChange, info }: {
    lang: string;
    supported: boolean;
    draft: WorktreeDraft;
    onChange: (next: WorktreeDraft) => void;
    info: WorktreeInfoState;
}) {
    const copy = worktreeCopy(lang);
    const data = info.phase === 'done' && info.result.ok ? info.result.data : null;
    const draftRef = useRef(draft);
    draftRef.current = draft;

    // Adopt defaults once per loaded repository: base = current branch, a fresh
    // generated branch name, and its location (unless the user edited them).
    const adoptedFor = useRef<string | null>(null);
    useEffect(() => {
        if (!data || adoptedFor.current === data.repoRoot) return;
        adoptedFor.current = data.repoRoot;
        const current = draftRef.current;
        const branch = current.branch || generateWorktreeBranch();
        onChange({
            ...current,
            baseRef: data.branches.includes(current.baseRef) ? current.baseRef : (data.currentBranch ?? data.branches[0] ?? 'HEAD'),
            branch,
            location: current.locationEdited ? current.location : worktreeLocationFor(data.defaultParent, branch),
        });
    }, [data, onChange]);

    const setBranch = (branch: string) => onChange({
        ...draft,
        branch,
        location: draft.locationEdited || !data ? draft.location : worktreeLocationFor(data.defaultParent, branch),
    });

    const unsupported = !supported || (info.phase === 'done' && !info.result.ok && info.result.unsupported);
    const branchInvalid = draft.enabled && !!draft.branch && !isPlausibleBranchName(draft.branch);

    return (
        <div className="nwt">
            <Checkbox
                className="nwt-toggle"
                checked={draft.enabled && !unsupported}
                disabled={unsupported}
                onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
            >
                {copy.toggle}
            </Checkbox>
            {unsupported ? (
                <div className="ns-agent-help">{copy.unsupported}</div>
            ) : !draft.enabled ? (
                <div className="ns-agent-help">{copy.toggleHint}</div>
            ) : info.phase === 'loading' ? (
                <div className="nwt-status"><Spinner size={13} /><span>{copy.loading}</span></div>
            ) : info.phase === 'done' && !info.result.ok ? (
                <div className="nwt-error" role="alert">{worktreeErrorText(copy, info.result.error)}</div>
            ) : data ? (
                <div className="nwt-fields">
                    <label className="ns-label" id="nwt-base-label">{copy.baseBranch}</label>
                    <Combobox
                        id="nwt-base"
                        label={copy.baseBranch}
                        labelledBy="nwt-base-label"
                        size="md"
                        searchable
                        value={draft.baseRef}
                        onChange={(baseRef) => onChange({ ...draft, baseRef })}
                        options={[
                            ...(!data.branches.includes(draft.baseRef) && draft.baseRef ? [{ value: draft.baseRef, label: draft.baseRef }] : []),
                            ...data.branches.map((b) => ({ value: b, label: b })),
                        ]}
                    />
                    <label className="ns-label" htmlFor="nwt-branch">{copy.newBranch}</label>
                    <div className="ns-path-row">
                        <input
                            id="nwt-branch"
                            className="ns-input mono"
                            value={draft.branch}
                            aria-invalid={branchInvalid || undefined}
                            onChange={(e) => setBranch(e.target.value)}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                        />
                        <button type="button" className="ns-save" title={copy.regenerate} aria-label={copy.regenerate} onClick={() => setBranch(generateWorktreeBranch())}>
                            <RefreshCw size={15} />
                        </button>
                    </div>
                    {branchInvalid && <div className="nwt-error">{copy.invalidBranch}</div>}
                    <label className="ns-label" htmlFor="nwt-location">{copy.location}</label>
                    <input
                        id="nwt-location"
                        className="ns-input mono"
                        value={draft.location}
                        onChange={(e) => onChange({ ...draft, location: e.target.value, locationEdited: true })}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                    <ul className="nwt-summary">
                        <li>{data.config.copy.length ? copy.summaryCopy(data.config.copy.join(', ')) : copy.summaryNoCopy}</li>
                        {data.config.link.length > 0 && <li>{copy.summaryLink(data.config.link.join(', '))}</li>}
                        <li>{!data.config.hasSetup ? copy.summarySetupNone : data.config.setupApproved ? copy.summarySetupApproved : copy.summarySetupNeeds}</li>
                        {data.config.error && <li className="nwt-summary-warn">{copy.configError(data.config.error)}</li>}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
