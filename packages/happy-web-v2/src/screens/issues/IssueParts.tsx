/** B-873: small shared pieces of the Issues screens (status glyph, assignee, row, run markers). */
import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Circle, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleSlash, Eye, OctagonAlert } from 'lucide-react';
import { agentAssigneeOf, type IssueAssigneeView, type IssueRunView, type IssueView } from '@slopus/happy-wire';
import { useAllMachines } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { Spinner } from '@/ui';
import { agentIdleStillInProgress, columnOf, runIsWorking } from './issuesModel';
import type { IssuesCopy } from './issuesCopy';

/** The DEV device harness serves the app under `/dev/device`; links stay inside it there. */
export function useIssuesBase(): string {
    const { pathname } = useLocation();
    return pathname.startsWith('/dev/device') ? '/dev/device' : '';
}
export const issuePath = (base: string, key: string) => `${base}/issues/${encodeURIComponent(key)}`;
export const sessionPath = (base: string, sessionId: string) => `${base}/session/${encodeURIComponent(sessionId)}`;

const STATUS_ICON = { backlog: CircleDashed, todo: Circle, in_progress: CircleDot, in_review: Eye, blocked: OctagonAlert, done: CircleCheck, cancelled: CircleSlash, other: CircleHelp } as const;

export function StatusGlyph({ status, size = 15 }: { status: string; size?: number }) {
    const column = columnOf(status);
    const Icon = STATUS_ICON[column];
    return <Icon size={size} className={`is-status is-status--${column}`} aria-hidden />;
}

/** machineId → display name, from the account's machines (offline included). */
export function useMachineNames(): (machineId: string) => string {
    const machines = useAllMachines({ includeOffline: true });
    return useMemo(() => {
        const map = new Map(machines.map((m) => [m.id, machineLabel(m)]));
        return (id: string) => map.get(id) ?? id.slice(0, 8);
    }, [machines]);
}

export function assigneeText(assignee: IssueAssigneeView, copy: IssuesCopy, machineName: (id: string) => string): string {
    if (assignee.kind === 'none') return copy.none;
    if (assignee.kind === 'self') return copy.self;
    const agent = agentAssigneeOf(assignee);
    return agent ? copy.agentOn(agent.agent, machineName(agent.machineId)) : copy.unknownAssignee;
}

export function PriorityTag({ priority, copy }: { priority: string; copy: IssuesCopy }) {
    if (priority === 'none' || !priority) return null;
    return <span className={`is-prio is-prio--${priority}`}>{copy.priorities[priority] ?? priority}</span>;
}

export function dueText(dueAt: number | null, lang: string): string {
    if (!dueAt) return '';
    try { return new Date(dueAt).toLocaleDateString(lang, { month: 'short', day: 'numeric' }); } catch { return ''; }
}

/** Row tail: spinner while a run works; the Q7 marker when the agent stopped but left it in progress. */
export function RunIndicator({ issue, runs, copy }: { issue: IssueView; runs: readonly IssueRunView[]; copy: IssuesCopy }) {
    const latest = runs.find((r) => r.id === issue.latestRunId) ?? runs[0];
    if (runIsWorking(latest)) return <span className="is-running" title={copy.running} aria-label={copy.running}><Spinner size={12} /></span>;
    if (agentIdleStillInProgress(issue, runs)) return <span className="is-idle-still" title={copy.idleStillHint}>{copy.idleStill}</span>;
    return null;
}
