/**
 * B-873b (spec 2026-11-issues §10 会话头): a session an issue run started shows
 * 「VH-12 · 进行中」 in its header; a click opens the issue. The binding comes
 * from the run table (`IssueRun.sessionId`) — the store's runs, or one
 * `GET /v1/issues/session/:sid` for a session that may belong to an issue.
 * Switch off / older server: availability is never `enabled`, nothing renders
 * and nothing is asked.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListTodo } from 'lucide-react';
import type { IssueRunView, IssueView } from '@slopus/happy-wire';
import { useSession } from '@/sync/storage';
import { lookupSessionIssue, useIssuesAvailability, useIssuesStore } from '@/sync/issuesStore';
import type { MenuItemDef } from '@/ui';
import { columnOf, mayBelongToIssue, sessionIssueBinding } from './issuesModel';
import { useIssuesCopy } from './issuesCopy';
import { issuePath, StatusGlyph, useIssuesBase } from './IssueParts';
import './issues.css';

export function useSessionIssue(sessionId: string): { issue: IssueView; run: IssueRunView } | null {
    const enabled = useIssuesAvailability() === 'enabled';
    const metadata = useSession(sessionId)?.metadata;
    // Select ids (stable strings), not the binding object: a fresh object per snapshot would re-render forever.
    const runId = useIssuesStore((s) => (enabled ? sessionIssueBinding(sessionId, s.runs, s.issues)?.run.id ?? null : null));
    const run = useIssuesStore((s) => (runId ? s.runs[runId] : undefined));
    const issue = useIssuesStore((s) => (run ? s.issues[run.issueId] : undefined));
    const ask = enabled && !runId && mayBelongToIssue(metadata);
    useEffect(() => { if (ask) void lookupSessionIssue(sessionId); }, [ask, sessionId]);
    return run && issue ? { issue, run } : null;
}

function useChipText(issue: IssueView) {
    const copy = useIssuesCopy();
    const status = copy.statuses[columnOf(issue.status)] ?? issue.status;
    return { label: copy.sessionChip(issue.key, status), hint: copy.sessionChipHint(issue.key, issue.title) };
}

export function SessionIssueChip({ issue }: { issue: IssueView }) {
    const navigate = useNavigate();
    const base = useIssuesBase();
    const { label, hint } = useChipText(issue);
    return (
        <button type="button" className="is-session-chip" data-testid="session-issue-chip" title={hint} aria-label={hint} onClick={() => navigate(issuePath(base, issue.key))}>
            <StatusGlyph status={issue.status} size={13} />
            <span className="is-session-chip-text">{label}</span>
        </button>
    );
}

/** Phone header (identity folded into ⋯): the same entry as a menu row. */
export function useSessionIssueMenuItem(issue: IssueView | null): MenuItemDef | null {
    const navigate = useNavigate();
    const base = useIssuesBase();
    const copy = useIssuesCopy();
    if (!issue) return null;
    const status = copy.statuses[columnOf(issue.status)] ?? issue.status;
    return { key: 'session-issue', label: copy.sessionChip(issue.key, status), icon: ListTodo, onSelect: () => navigate(issuePath(base, issue.key)) };
}
