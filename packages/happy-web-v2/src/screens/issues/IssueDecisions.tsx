/**
 * B-873 (spec §7/§10): the Issues part of 「需要我决策」 — on /board under the
 * automation band, and on the Issues page's 等我处理 tab. Three kinds, read
 * from the issues store (no dependency on the attention bridge):
 *   - in_review → 「完成」 (done) / 「退回」 (todo + the note as my comment,
 *     which §6 routes back to the agent);
 *   - blocked → open it;
 *   - a failed run that never got a session and is not acknowledged — the
 *     Web-merged path, like automation runs (spec Q8) → 重试 / 换 agent / 知道了.
 * Renders nothing when there is nothing to decide.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, CornerUpLeft, RotateCw, UserRoundCog, X } from 'lucide-react';
import type { IssueRunView, IssueView } from '@slopus/happy-wire';
import { Modal } from '@/modal';
import { toast } from '@/ui';
import { acceptIssue, ackIssueRunFailure, returnIssue, startIssueRun, updateIssue, useIssuesStore } from '@/sync/issuesStore';
import { failedRunsNeedingYou } from './issuesModel';
import { issuePath, StatusGlyph, useIssuesBase, useMachineNames } from './IssueParts';
import { AssigneeDialog } from './IssueDialogs';
import { useIssuesCopy, type IssuesCopy } from './issuesCopy';
import { issueErrorText } from './issueErrors';
import './issues.css';

/** In-review / blocked issues and failed runs waiting on the owner, newest first. */
export function issueDecisionsOf(issues: Readonly<Record<string, IssueView>>, runs: Readonly<Record<string, IssueRunView>>) {
    const live = Object.values(issues).filter((i) => !i.deletedAt);
    return {
        review: live.filter((i) => i.status === 'in_review').sort((a, b) => b.statusChangedAt - a.statusChangedAt),
        blocked: live.filter((i) => i.status === 'blocked').sort((a, b) => b.statusChangedAt - a.statusChangedAt),
        failed: failedRunsNeedingYou(runs, issues),
    };
}

/** 退回 asks for an optional note first (spec §7: it becomes my comment, routed to the agent). */
export async function confirmReturn(issue: IssueView, copy: IssuesCopy): Promise<boolean> {
    const note = await Modal.prompt(copy.rejectTitle, copy.rejectBody, { placeholder: copy.rejectPh, multiline: true, confirmText: copy.reject, cancelText: copy.cancel });
    if (note === null) return false;
    await returnIssue(issue.id, note);
    return true;
}

export function IssueDecisions() {
    const copy = useIssuesCopy();
    const navigate = useNavigate();
    const base = useIssuesBase();
    const issues = useIssuesStore((s) => s.issues);
    const runs = useIssuesStore((s) => s.runs);
    const machineName = useMachineNames();
    const { review, blocked, failed } = useMemo(() => issueDecisionsOf(issues, runs), [issues, runs]);
    const [busy, setBusy] = useState<string | null>(null);
    const [switching, setSwitching] = useState<IssueRunView | null>(null);
    const total = review.length + blocked.length + failed.length;
    if (total === 0) return null;
    const guard = async (key: string, work: () => Promise<unknown>, done?: string) => {
        if (busy) return;
        setBusy(key);
        try { await work(); if (done) toast.success(done); } catch (e) { toast.error(issueErrorText(e, copy)); } finally { setBusy(null); }
    };
    const open = (issue: IssueView) => navigate(issuePath(base, issue.key));
    return (
        <section className="is-decisions" aria-labelledby="is-dec-title" data-testid="issue-decisions">
            <header className="is-dec-head">
                <span id="is-dec-title" className="is-dec-title">{copy.decisions}<span className="is-count">{total}</span></span>
                <span className="is-muted is-dec-hint">{copy.decisionsHint}</span>
            </header>
            <ul className="is-dec-list">
                {review.map((issue) => (
                    <li key={issue.id} className="is-dec-row" data-kind="review" data-issue={issue.key}>
                        <button type="button" className="is-dec-main" onClick={() => open(issue)}>
                            <StatusGlyph status={issue.status} /><span className="is-dec-text">{copy.reviewTitle(issue.key, issue.title)}</span>
                        </button>
                        <span className="is-dec-acts">
                            <button type="button" className="is-primary" disabled={!!busy} aria-busy={busy === `done:${issue.id}`} data-testid="issue-accept"
                                onClick={() => void guard(`done:${issue.id}`, () => acceptIssue(issue.id), copy.accepted)}><Check size={14} aria-hidden />{copy.accept}</button>
                            <button type="button" className="is-soft" disabled={!!busy} data-testid="issue-return"
                                onClick={() => void guard(`ret:${issue.id}`, async () => { if (await confirmReturn(issue, copy)) toast.success(copy.rejected); })}><CornerUpLeft size={14} aria-hidden />{copy.reject}</button>
                        </span>
                    </li>
                ))}
                {blocked.map((issue) => (
                    <li key={issue.id} className="is-dec-row" data-kind="blocked" data-issue={issue.key}>
                        <button type="button" className="is-dec-main" onClick={() => open(issue)}>
                            <StatusGlyph status={issue.status} /><span className="is-dec-text">{copy.blockedTitle(issue.key, issue.title)}</span>
                        </button>
                        <span className="is-dec-acts">
                            <button type="button" className="is-soft" onClick={() => open(issue)}><ArrowUpRight size={14} aria-hidden />{copy.openIssue(issue.key)}</button>
                        </span>
                    </li>
                ))}
                {failed.map((run) => {
                    const issue = issues[run.issueId];
                    return (
                        <li key={run.id} className="is-dec-row" data-kind="failed" data-issue={issue.key}>
                            <button type="button" className="is-dec-main" onClick={() => open(issue)}>
                                <StatusGlyph status="blocked" />
                                <span className="is-dec-text">{copy.failedTitle(issue.key)} · {run.agent} · {machineName(run.machineId)}{run.error ? <span className="is-dec-error"> — {run.error}</span> : null}</span>
                            </button>
                            <span className="is-dec-acts">
                                <button type="button" className="is-soft" disabled={!!busy} onClick={() => void guard(`retry:${run.id}`, () => startIssueRun(issue.id, {}))}><RotateCw size={14} aria-hidden />{copy.retryRun}</button>
                                <button type="button" className="is-soft" disabled={!!busy} onClick={() => setSwitching(run)}><UserRoundCog size={14} aria-hidden />{copy.switchAgent}</button>
                                <button type="button" className="is-soft" disabled={!!busy} onClick={() => void guard(`ack:${run.id}`, () => ackIssueRunFailure(run.id))}><X size={14} aria-hidden />{copy.ack}</button>
                            </span>
                        </li>
                    );
                })}
            </ul>
            {switching && issues[switching.issueId] && (
                <AssigneeDialog value={issues[switching.issueId].assignee} status={issues[switching.issueId].status} projectId={issues[switching.issueId].projectId}
                    onClose={() => setSwitching(null)}
                    onApply={async (assignee) => {
                        if (assignee.kind === 'agent') await startIssueRun(switching.issueId, { assignee, reassign: true });
                        else await updateIssue(switching.issueId, { assignee });
                    }} />
            )}
        </section>
    );
}
