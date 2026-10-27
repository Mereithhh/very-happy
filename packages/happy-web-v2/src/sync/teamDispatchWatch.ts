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
 * after the action. Only spawn operations that are new (or the one being
 * retried) and still unfinished count, so a poll racing other work never
 * claims somebody else's launch.
 */
export function teamDispatchTargets(before: TeamState | null, after: TeamState, action: TeamAction): TeamDispatchTargets {
    if (action.type !== 'delegate' && action.type !== 'retry-operation' && action.type !== 'handoff') return { operationIds: [], delivered: [] };
    const beforeOps = new Set((before?.operations ?? []).map((op) => op.id));
    const retried = action.type === 'retry-operation' ? action.operationId : null;
    const ops = after.operations.filter((op) => op.type === 'spawn' && UNFINISHED.includes(op.status) && (op.id === retried || !beforeOps.has(op.id)));
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
    | { kind: 'failed'; name: string; error: string };

/** Where one watched spawn stands in a fresh team snapshot. Pure. */
export function watchedOperationOutcome(team: TeamState, operationId: string): WatchedOutcome {
    const op = team.operations.find((o) => o.id === operationId);
    if (!op) return { kind: 'pending' };
    const name = team.bots.find((b) => b.id === op.botId)?.name ?? '';
    if (op.status === 'completed') return op.sessionId ? { kind: 'created', sessionId: op.sessionId, name } : { kind: 'pending' };
    if (op.status === 'failed') return { kind: 'failed', name, error: op.error ?? 'spawn_failed' };
    return { kind: 'pending' };
}

/** `failed`: its failure was toasted — the daemon may still retry it (「自动重试 2/5」), so keep watching for a session. */
const watching = new Map<string, { teamId: string; until: number; failed?: boolean }>();
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
            .map(([id]) => ({ id, outcome: watchedOperationOutcome(team, id) }))
            .filter(({ outcome }) => outcome.kind !== 'pending');
        // The sidebar nests member rows under their team: hand it the new binding before the reveal.
        if (outcomes.some(({ outcome }) => outcome.kind === 'created')) await refreshTeamNavigation();
        for (const { id, outcome } of outcomes) {
            const w = watching.get(id);
            if (!w) continue;
            if (outcome.kind === 'created') { watching.delete(id); announceDispatched({ sessionId: outcome.sessionId, name: outcome.name }); }
            else if (outcome.kind === 'failed' && !w.failed) { w.failed = true; announceDispatchFailed({ name: outcome.name, reason: outcome.error }); }
        }
    }
    if (watching.size) timer = setTimeout(() => void poll(), TEAM_DISPATCH_POLL_MS);
}

/** Called by the Teams page after a successful action. */
export function watchTeamDispatch(before: TeamState | null, after: TeamState, action: TeamAction, now = Date.now()): void {
    const targets = teamDispatchTargets(before, after, action);
    for (const d of targets.delivered) announceDispatched({ sessionId: d.sessionId, name: d.name, kind: 'delivered' });
    for (const id of targets.operationIds) watching.set(id, { teamId: after.id, until: now + TEAM_DISPATCH_WATCH_MS });
    if (watching.size && !timer) timer = setTimeout(() => void poll(), TEAM_DISPATCH_POLL_MS);
}
