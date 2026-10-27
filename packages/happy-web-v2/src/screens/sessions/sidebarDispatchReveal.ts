/**
 * Sidebar side of the dispatch feedback (sync/dispatchFeedback.ts): which rows
 * carry the 「新」 mark, how many a folded group / team hides, and the step the
 * one-shot reveal takes next. Pure, unit-tested.
 */
import type { TeamState } from '@slopus/happy-wire';
import { teamSessionMembership } from './teamNavigation';

interface RowLike {
    sessionId?: string;
    team?: unknown;
    teamHistoryLink?: boolean;
    share?: unknown;
}

/** A conversation row (not a team node / history link / shared row) whose session is marked new. */
export function isFreshRow(row: RowLike, fresh: Readonly<Record<string, number>>): boolean {
    return !row.team && !row.teamHistoryLink && !row.share && !!row.sessionId && row.sessionId in fresh;
}

export function freshRowCount(rows: readonly RowLike[], fresh: Readonly<Record<string, number>>): number {
    let n = 0;
    for (const row of rows) if (isFreshRow(row, fresh)) n++;
    return n;
}

/** New conversations of a team's members — the folded team row's hint. */
export function teamFreshCount(team: TeamState, fresh: Readonly<Record<string, number>>): number {
    const ids = new Set<string>();
    for (const bot of team.bots) if (bot.sessionId) ids.add(bot.sessionId);
    for (const op of team.operations) if (op.type === 'spawn' && op.status === 'completed' && op.sessionId) ids.add(op.sessionId);
    let n = 0;
    for (const id of ids) if (id in fresh) n++;
    return n;
}

export type DispatchRevealStep =
    | { kind: 'wait' }
    | { kind: 'expand'; groupId: string }
    | { kind: 'scroll'; key: string };

/**
 * Next step of revealing `sessionId`: open its team node (member rows only
 * exist under an open team), then its folded section, then scroll. `wait`
 * while the row has not reached the list yet (a team member's session lands
 * seconds after the spawn) — the caller's TTL ends the wait.
 */
export function planDispatchReveal(input: {
    sessionId: string;
    teams: TeamState[];
    expandedTeams: ReadonlySet<string>;
    teamGroupId: (teamId: string) => string;
    sections: readonly { id: string; collapsible: boolean; open: boolean; allRows: readonly (RowLike & { key: string })[] }[];
}): DispatchRevealStep {
    const team = teamSessionMembership(input.teams).get(input.sessionId)?.team;
    if (team && !input.expandedTeams.has(team.id)) return { kind: 'expand', groupId: input.teamGroupId(team.id) };
    for (const sec of input.sections) {
        const row = sec.allRows.find((r) => r.sessionId === input.sessionId && !r.team && !r.teamHistoryLink);
        if (!row) continue;
        if (sec.collapsible && !sec.open) return { kind: 'expand', groupId: sec.id };
        return { kind: 'scroll', key: row.key };
    }
    return { kind: 'wait' };
}
