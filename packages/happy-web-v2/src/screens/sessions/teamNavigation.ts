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
  /** B-674: one fold row standing in for the team's archived members. */
  | { kind: 'archived'; team: TeamState; count: number; open: boolean };
/** B-674: which member rows are archived, and which teams show them (device-local choice). */
export interface ArchivedMemberFold<T> { isArchived: (row: T) => boolean; open: ReadonlySet<string> }
/** Preserve ordinary rows' relative order. Put each team at its first member,
 * keep children in that same order, and include newly created empty teams.
 * With `archived`, an expanded team lists its live members first and folds the
 * archived ones behind a single 「已归档 N 个」 entry (B-674). */
export function groupTeamNavigation<T extends { sessionId?: string }>(rows: T[], teams: TeamState[], expanded: ReadonlySet<string>, archived?: ArchivedMemberFold<T>): TeamNavigationEntry<T>[] {
  const membership = teamSessionMembership(teams);
  const children = new Map<string, T[]>();
  for (const row of rows) {
    const member = row.sessionId ? membership.get(row.sessionId) : undefined;
    if (member) children.set(member.team.id, [...(children.get(member.team.id) ?? []), row]);
  }
  const emitted = new Set<string>();
  const output: TeamNavigationEntry<T>[] = [];
  const child = (row: T, team: TeamState): TeamNavigationEntry<T> => ({ kind: 'row', row, team, bot: membership.get(row.sessionId!)?.bot });
  const emit = (team: TeamState) => {
    if (emitted.has(team.id)) return;
    emitted.add(team.id);
    output.push({ kind: 'team', team });
    if (!expanded.has(team.id)) return;
    const kids = children.get(team.id) ?? [];
    const old = archived ? kids.filter(archived.isArchived) : [];
    for (const row of kids) if (!old.includes(row)) output.push(child(row, team));
    if (old.length === 0) return;
    const open = archived!.open.has(team.id);
    output.push({ kind: 'archived', team, count: old.length, open });
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

/** B-674: the device-local fold key for a team's archived members (sidebarCollapsedGroups). */
export function teamArchivedGroupId(teamId: string): string {
  return `team-archived:${teamId}`;
}

/** A registered member is visible even before its first session exists. */
export function unstartedTeamMembers(team: TeamState) {
  return team.bots.filter(bot => !botHistorySessionId(team, bot)).map(bot => {
    const task = team.tasks.find(task => task.assigneeBotId === bot.id && !['done', 'cancelled'].includes(task.status));
    const operation = task && team.operations.find(op => op.type === 'spawn' && op.botId === bot.id && op.attemptId === task.currentAttemptId);
    return { bot, task, failed: !!operation && ['failed', 'unknown'].includes(operation.status), href: `/teams/${encodeURIComponent(team.id)}${task ? `?task=${encodeURIComponent(task.id)}` : ''}` };
  });
}
