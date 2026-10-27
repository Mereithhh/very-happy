/**
 * Team dispatches land asynchronously: 新任务 / 重试 / 转交 answer with the
 * team state while the daemon is still launching the member. This watches the
 * spawn operations one action queued until each has a session (or failed) and
 * then hands over to dispatchFeedback — the toast, sidebar reveal and 「新」.
 * A task given to a member that already has a live session is delivered as a
 * message: same toast/reveal on that session, no 「新」.
 */
import type { TeamAction, TeamOperation, TeamState } from '@slopus/happy-wire';
import { getTeam } from './teams';
import { announceDispatched, announceDispatchFailed } from './dispatchFeedback';
import { refreshTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamOperationErrorKind } from '@/screens/teams/teamView';
import { workspaceCopyFor } from '@/screens/teams/workspaceCopy';
import { getCurrentLanguage } from '@/text';

/** A member launch normally completes in seconds; give up quietly after this. */
export const TEAM_DISPATCH_WATCH_MS = 5 * 60_000;
export const TEAM_DISPATCH_POLL_MS = 2_000;

const UNFINISHED: ReadonlyArray<TeamOperation['status']> = ['pending', 'claimed', 'unknown'];

export interface TeamDispatchTargets {
    /** spawn operations to wait for */
    operationIds: string[];
    /** tasks delivered to a member's live session right away */
    delivered: { sessionId: string; name: string }[];
}

/**
 * What one user action on a team started. Pure: compares the team before and
 * after the action. Spawn operations that are new and still unfinished count,
 * so a poll racing other work never claims somebody else's launch. The one
 * being retried counts whatever its status: `retry-operation` only stamps
 * `retryRequestedAt` and the op stays `failed` / `unknown` until the daemon
 * reruns it (QA17 P1-1).
 */
export function teamDispatchTargets(before: TeamState | null, after: TeamState, action: TeamAction): TeamDispatchTargets {
    if (action.type !== 'delegate' && action.type !== 'retry-operation' && action.type !== 'handoff') return { operationIds: [], delivered: [] };
    const beforeOps = new Set((before?.operations ?? []).map((op) => op.id));
    const retried = action.type === 'retry-operation' ? action.operationId : null;
    const ops = after.operations.filter((op) => op.type === 'spawn' && (op.id === retried || (UNFINISHED.includes(op.status) && !beforeOps.has(op.id))));
    const delivered: TeamDispatchTargets['delivered'] = [];
    if (action.type !== 'retry-operation') {
        const beforeTasks = new Set((before?.tasks ?? []).map((task) => task.id));
        const beforeAttempts = new Map((before?.tasks ?? []).map((task) => [task.id, task.currentAttemptId]));
        for (const task of after.tasks) {
            const fresh = !beforeTasks.has(task.id) || beforeAttempts.get(task.id) !== task.currentAttemptId;
            if (!fresh || ops.some((op) => op.taskId === task.id)) continue;
            const bot = after.bots.find((b) => b.id === task.assigneeBotId);
            if (bot?.sessionId) delivered.push({ sessionId: bot.sessionId, name: bot.name });
        }
    }
    return { operationIds: ops.map((op) => op.id), delivered };
}

export type WatchedOutcome =
    | { kind: 'pending' }
    | { kind: 'created'; sessionId: string; name: string }
    | { kind: 'failed'; name: string; error: string; unknown: boolean };

/** A failed / unknown op's state as of a snapshot: a retry leaves it unchanged until the daemon reruns it. */
export function operationFailureStamp(op: Pick<TeamOperation, 'status' | 'error'>): string | null {
    return op.status === 'failed' || op.status === 'unknown' ? `${op.status}\n${op.error ?? ''}` : null;
}

/**
 * Where one watched spawn stands in a fresh team snapshot. Pure. `unknown`
 * (it failed while spawning: the board asks to verify it) is a failure too
 * (QA17 P2-2). `baseline` is the failure a 重试 started from: until the op
 * moves on from it, the retry has not run yet.
 */
export function watchedOperationOutcome(team: TeamState, operationId: string, baseline: string | null = null): WatchedOutcome {
    const op = team.operations.find((o) => o.id === operationId);
    if (!op) return { kind: 'pending' };
    const name = team.bots.find((b) => b.id === op.botId)?.name ?? '';
    if (op.status === 'completed') return op.sessionId ? { kind: 'created', sessionId: op.sessionId, name } : { kind: 'pending' };
    const stamp = operationFailureStamp(op);
    if (stamp && stamp !== baseline) return { kind: 'failed', name, error: op.error ?? 'spawn_failed', unknown: op.status === 'unknown' };
    return { kind: 'pending' };
}

/**
 * The failure in the user's language — the same sentence the team board shows
 * (OperationError); the raw daemon text stays behind the board's 「详情」
 * (QA17 P2-1). Pure apart from reading the current language.
 */
export function teamFailureSummary(error: string, unknown: boolean, lang: string = getCurrentLanguage()): string {
    const copy = workspaceCopyFor(lang);
    const kind = teamOperationErrorKind(error);
    // An uncertain spawn's own text is a raw OS error; what the owner must do is verify it.
    if (unknown && (!kind || kind === 'other')) return copy.opError.outcomeUnknown;
    return copy.opError[kind ?? 'other'] ?? copy.opError.other;
}

/**
 * `failed`: its failure was toasted — the daemon may still retry it (「自动重试 2/5」), so keep watching for a session.
 * `baseline`: a retried op's failure when 重试 was clicked (operationFailureStamp); not reported again.
 */
const watching = new Map<string, { teamId: string; until: number; failed?: boolean; baseline: string | null }>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function poll(): Promise<void> {
    timer = null;
    const now = Date.now();
    for (const [id, w] of watching) if (now > w.until) watching.delete(id);
    const teamIds = [...new Set([...watching.values()].map((w) => w.teamId))];
    for (const teamId of teamIds) {
        let team: TeamState;
        try { team = (await getTeam(teamId)).team; } catch { continue; }
        const outcomes = [...watching].filter(([, w]) => w.teamId === teamId)
            .map(([id, w]) => ({ id, outcome: watchedOperationOutcome(team, id, w.baseline) }))
            .filter(({ outcome }) => outcome.kind !== 'pending');
        // The sidebar nests member rows under their team: hand it the new binding before the reveal.
        if (outcomes.some(({ outcome }) => outcome.kind === 'created')) await refreshTeamNavigation();
        for (const { id, outcome } of outcomes) {
            const w = watching.get(id);
            if (!w) continue;
            if (outcome.kind === 'created') { watching.delete(id); announceDispatched({ sessionId: outcome.sessionId, name: outcome.name }); }
            else if (outcome.kind === 'failed' && !w.failed) {
                w.failed = true;
                announceDispatchFailed({ name: outcome.name, reason: teamFailureSummary(outcome.error, outcome.unknown), href: `/teams/${encodeURIComponent(teamId)}` });
            }
        }
    }
    if (watching.size) timer = setTimeout(() => void poll(), TEAM_DISPATCH_POLL_MS);
}

/** Tests only. */
export function resetTeamDispatchWatchForTests(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    watching.clear();
}

/** Called by the Teams page after a successful action. */
export function watchTeamDispatch(before: TeamState | null, after: TeamState, action: TeamAction, now = Date.now()): void {
    const targets = teamDispatchTargets(before, after, action);
    for (const d of targets.delivered) announceDispatched({ sessionId: d.sessionId, name: d.name, kind: 'delivered' });
    for (const id of targets.operationIds) {
        const op = after.operations.find((o) => o.id === id);
        watching.set(id, { teamId: after.id, until: now + TEAM_DISPATCH_WATCH_MS, baseline: op ? operationFailureStamp(op) : null });
    }
    if (watching.size && !timer) timer = setTimeout(() => void poll(), TEAM_DISPATCH_POLL_MS);
}
