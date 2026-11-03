import type { IssueCommentView, IssueRunView, IssueView } from '@slopus/happy-wire';
import { IssueRequestError, IssuesUnsupportedError } from './client';

/**
 * B-874: one sentence per server error code (spec §4), shared by the
 * `issue_*` MCP tools and `very-happy issue`. Always `<code>: <sentence>` so an
 * agent (and a test) can branch on the code the server returned.
 */
const MESSAGES: Record<string, string> = {
    issue_status_forbidden: 'Agents may only set in_progress, in_review or blocked. Only the owner sets done or cancelled; move it to in_review with a summary instead.',
    issue_closed: 'This issue is closed (done or cancelled). Its status cannot be changed by an agent; you can still comment.',
    issue_comment_required: 'in_review and blocked need a comment: say what you delivered and how it was verified, or exactly what you need.',
    issue_not_bound: 'This session is not working on an issue (it was not started from one).',
    issue_run_not_current: 'This issue has moved to a newer run; stop changing it.',
    issue_comment_quota_exceeded: 'Too many issue comments from this run in the last hour; wait before commenting again.',
    issue_not_found: 'No such issue (it may have been deleted).',
    issue_todo_deleted: 'This todo id belongs to a deleted todo and cannot be reused; add with a new UUID.',
    issue_version_conflict: 'The issue changed since you read it; read it again before deciding what to change.',
    issue_assignee_unsupported: 'That assignee is not supported.',
    issue_agent_unsupported: 'That agent cannot be assigned an issue (Claude, Codex or pi only).',
    issue_no_directory: 'No folder for this agent on that machine: pass a directory or put the issue in a project with a folder there.',
    issue_machine_not_found: 'No such machine on this account.',
    issue_project_not_found: 'No such project.',
    issue_parent_cycle: 'That parent would create a cycle.',
    issue_count_quota_exceeded: 'This account has reached the issue limit.',
    transaction_conflict: 'The server was busy; retry.',
    rate_limited: 'Rate limited; retry later.',
    not_signed_in: 'Sign in to Very Happy with `very-happy auth login` first.',
};

export const ISSUES_UNSUPPORTED_TEXT = 'issues_unsupported: This Very Happy server does not support Issues (or they are turned off).';

export function describeIssueError(error: unknown): string {
    if (error instanceof IssuesUnsupportedError) return ISSUES_UNSUPPORTED_TEXT;
    if (error instanceof IssueRequestError) {
        const code = error.code ?? (error.status === 429 ? 'rate_limited' : null);
        if (code) {
            const server = typeof error.details.message === 'string' ? error.details.message : null;
            return `${code}: ${server ?? MESSAGES[code] ?? 'Issue request failed.'}`;
        }
        return `Issue request failed (HTTP ${error.status})`;
    }
    return error instanceof Error && error.message ? error.message : 'Issue request failed';
}

function assigneeLabel(issue: Pick<IssueView, 'assignee'>): string {
    const a = issue.assignee as { kind: string; agent?: string; machineId?: string };
    if (a.kind === 'agent') return `${a.agent ?? 'agent'}@${(a.machineId ?? '').slice(0, 8)}`;
    return a.kind;
}

function when(ms: number | null | undefined): string {
    return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '';
}

export function formatIssueLine(issue: IssueView): string {
    const extra = [issue.priority !== 'none' ? issue.priority : null, issue.labels.length ? issue.labels.join(',') : null].filter(Boolean).join(' · ');
    return `${issue.key}  [${issue.status}]  ${issue.title}  (${assigneeLabel(issue)}${extra ? ` · ${extra}` : ''})`;
}

function commentLine(c: IssueCommentView): string {
    const who = c.author.kind === 'agent' ? 'agent' : c.author.kind === 'user' ? 'owner' : c.author.kind;
    const body = c.kind === 'comment' ? c.body : `(${c.kind}) ${c.body}`;
    return `- ${when(c.createdAt)} [${who}] ${body.replace(/\s+/g, ' ').slice(0, 600)}`;
}

function runLine(r: IssueRunView): string {
    return `- run #${r.seq} ${r.trigger} · ${r.agent} · ${r.status}${r.sessionId ? ` · session ${r.sessionId}` : ''}${r.error ? ` · ${r.error.slice(0, 200)}` : ''}`;
}

/** Plain text for `issue_get` and `very-happy issue show` (agents read it; no ANSI). */
export function formatIssueDetail(input: { issue: IssueView; comments: readonly IssueCommentView[]; runs?: readonly IssueRunView[]; current?: boolean; bound?: boolean }): string {
    const { issue } = input;
    const meta = [`status: ${issue.status}`, `priority: ${issue.priority}`, `assignee: ${assigneeLabel(issue)}`];
    if (issue.labels.length) meta.push(`labels: ${issue.labels.join(', ')}`);
    if (issue.dueAt) meta.push(`due: ${new Date(issue.dueAt).toISOString().slice(0, 10)}`);
    const lines = [`${issue.key}: ${issue.title}`, meta.join(' · ')];
    if (input.bound) lines.push(input.current ? 'This session is the issue\'s current run (issue_update / issue_comment allowed).' : 'This session\'s run is no longer current: do not change this issue.');
    lines.push('', issue.description.trim() || '(no description)');
    const comments = input.comments.slice(-10);
    if (comments.length) lines.push('', 'Timeline (oldest first):', ...comments.map(commentLine));
    if (input.runs?.length) lines.push('', 'Runs:', ...input.runs.map(runLine));
    return lines.join('\n');
}
