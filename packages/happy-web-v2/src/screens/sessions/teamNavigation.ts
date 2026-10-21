import type { TeamBot, TeamState } from '@slopus/happy-wire';

/** A retired managed member keeps its immutable spawn receipt as a history link. */
export function botHistorySessionId(team: TeamState, bot: TeamBot): string | null {
  if (bot.sessionId) return bot.sessionId;
  return team.operations.filter(operation => operation.type === 'spawn' && operation.status === 'completed' && operation.botId === bot.id && operation.sessionId)
    .sort((a, b) => b.generation - a.generation || b.createdAt - a.createdAt)[0]?.sessionId ?? null;
}

/** Ambiguous membership must never silently hide a conversation. */
export function teamSessionMembership(teams: TeamState[]) {
  const memberships = new Map<string, { team: TeamState; bot: TeamBot }>();
  const ambiguous = new Set<string>();
  const register = (sessionId: string, team: TeamState, bot: TeamBot) => {
    const previous = memberships.get(sessionId);
    if (previous && (previous.team.id !== team.id || previous.bot.id !== bot.id)) ambiguous.add(sessionId);
    else memberships.set(sessionId, { team, bot });
  };
  for (const team of teams) for (const bot of team.bots) {
    if (bot.sessionId) register(bot.sessionId, team, bot);
    for (const operation of team.operations) {
      if (operation.botId === bot.id && operation.type === 'spawn' && operation.status === 'completed' && operation.sessionId) register(operation.sessionId, team, bot);
    }
  }
  for (const id of ambiguous) memberships.delete(id);
  return memberships;
}

/** Only add receipt-backed team sessions; ordinary archived conversations stay archived. */
export function missingTeamSessionIds(existingSessionIds: ReadonlySet<string>, teams: TeamState[]): string[] {
  return [...teamSessionMembership(teams).keys()].filter(id => !existingSessionIds.has(id));
}

export type TeamNavigationEntry<T> =
  | { kind: 'row'; row: T; team?: TeamState; bot?: TeamBot }
  | { kind: 'team'; team: TeamState }
  /** B-674 / B-690: one fold row standing in for the team's inactive members. */
  | { kind: 'inactive'; team: TeamState; count: number; open: boolean };
/** B-690: which member rows are inactive (`teamMemberInactive`), which teams show
 *  them (device-local choice), and how many sessionless inactive members the
 *  caller folds in itself (`extra`, rendered right after the fold row). */
export interface InactiveMemberFold<T> { isInactive: (row: T, team: TeamState, bot: TeamBot | undefined) => boolean; open: ReadonlySet<string>; extra?: (team: TeamState) => number }
/** Preserve ordinary rows' relative order. Put each team at its first member,
 * keep children in that same order, and include newly created empty teams.
 * With `inactive`, an expanded team lists its active members first and folds the
 * inactive ones behind a single 「已停用 N 个」 entry (B-674, B-690). */
export function groupTeamNavigation<T extends { sessionId?: string }>(rows: T[], teams: TeamState[], expanded: ReadonlySet<string>, inactive?: InactiveMemberFold<T>): TeamNavigationEntry<T>[] {
  const membership = teamSessionMembership(teams);
  const children = new Map<string, T[]>();
  for (const row of rows) {
    const member = row.sessionId ? membership.get(row.sessionId) : undefined;
    if (member) children.set(member.team.id, [...(children.get(member.team.id) ?? []), row]);
  }
  const emitted = new Set<string>();
  const output: TeamNavigationEntry<T>[] = [];
  const botOf = (row: T) => membership.get(row.sessionId!)?.bot;
  const child = (row: T, team: TeamState): TeamNavigationEntry<T> => ({ kind: 'row', row, team, bot: botOf(row) });
  const emit = (team: TeamState) => {
    if (emitted.has(team.id)) return;
    emitted.add(team.id);
    output.push({ kind: 'team', team });
    if (!expanded.has(team.id)) return;
    const kids = children.get(team.id) ?? [];
    const old = inactive ? kids.filter((row) => inactive.isInactive(row, team, botOf(row))) : [];
    for (const row of kids) if (!old.includes(row)) output.push(child(row, team));
    const count = old.length + (inactive?.extra?.(team) ?? 0);
    if (count === 0) return;
    const open = inactive!.open.has(team.id);
    output.push({ kind: 'inactive', team, count, open });
    if (open) for (const row of old) output.push(child(row, team));
  };
  for (const row of rows) {
    const member = row.sessionId ? membership.get(row.sessionId) : undefined;
    if (member) emit(member.team);
    else output.push({ kind: 'row', row });
  }
  for (const team of teams) emit(team);
  return output;
}

/** B-674/B-690: the device-local fold key for a team's inactive members
 *  (sidebarCollapsedGroups), shared by the sidebar and the Teams page. The
 *  `team-archived:` prefix predates B-690 and is kept so saved choices survive. */
export function teamInactiveGroupId(teamId: string): string {
  return `team-archived:${teamId}`;
}

/** B-690: a member idle this long, with nothing assigned, counts as no longer used. */
export const TEAM_MEMBER_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * B-690 — the ONE rule for 「已停用」 team members (sidebar fold and Teams page).
 * A member with an open task (queued / running / submitted) is always active:
 * something is waiting on it. Otherwise it is inactive when
 *  - its conversation is archived (`sessionArchived`, the B-674 case), or
 *  - it holds no session: stopped after its work (the team's cleanup unbinds
 *    it), or never started and nothing will start it, or
 *  - its last lifecycle event is `exited`, or
 *  - its last event is older than `TEAM_MEMBER_IDLE_MS`.
 * A member with a session and no recorded event stays active (no evidence).
 */
export function teamMemberInactive(team: TeamState, bot: TeamBot, sessionArchived: boolean, now: number): boolean {
  if (team.tasks.some((task) => task.assigneeBotId === bot.id && !['done', 'cancelled'].includes(task.status))) return false;
  if (sessionArchived || !bot.sessionId || bot.lastEvent === 'exited') return true;
  return bot.lastEventAt !== undefined && now - bot.lastEventAt > TEAM_MEMBER_IDLE_MS;
}

/** A registered member is visible even before its first session exists. */
export function unstartedTeamMembers(team: TeamState) {
  return team.bots.filter(bot => !botHistorySessionId(team, bot)).map(bot => {
    const task = team.tasks.find(task => task.assigneeBotId === bot.id && !['done', 'cancelled'].includes(task.status));
    const operation = task && team.operations.find(op => op.type === 'spawn' && op.botId === bot.id && op.attemptId === task.currentAttemptId);
    return { bot, task, failed: !!operation && ['failed', 'unknown'].includes(operation.status), href: `/teams/${encodeURIComponent(team.id)}${task ? `?task=${encodeURIComponent(task.id)}` : ''}` };
  });
}
