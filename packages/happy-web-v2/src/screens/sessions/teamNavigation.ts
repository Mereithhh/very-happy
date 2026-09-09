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

export type TeamNavigationEntry<T> = { kind: 'row'; row: T; team?: TeamState; bot?: TeamBot } | { kind: 'team'; team: TeamState };
/** Preserve ordinary rows' relative order. Put each team at its first member,
 * keep children in that same order, and include newly created empty teams. */
export function groupTeamNavigation<T extends { sessionId?: string }>(rows: T[], teams: TeamState[], expanded: ReadonlySet<string>): TeamNavigationEntry<T>[] {
  const membership = teamSessionMembership(teams);
  const children = new Map<string, T[]>();
  for (const row of rows) {
    const member = row.sessionId ? membership.get(row.sessionId) : undefined;
    if (member) children.set(member.team.id, [...(children.get(member.team.id) ?? []), row]);
  }
  const emitted = new Set<string>();
  const output: TeamNavigationEntry<T>[] = [];
  const emit = (team: TeamState) => {
    if (emitted.has(team.id)) return;
    emitted.add(team.id);
    output.push({ kind: 'team', team });
    if (expanded.has(team.id)) for (const row of children.get(team.id) ?? []) {
      output.push({ kind: 'row', row, team, bot: membership.get(row.sessionId!)?.bot });
    }
  };
  for (const row of rows) {
    const member = row.sessionId ? membership.get(row.sessionId) : undefined;
    if (member) emit(member.team);
    else output.push({ kind: 'row', row });
  }
  for (const team of teams) emit(team);
  return output;
}

/** A registered member is visible even before its first session exists. */
export function unstartedTeamMembers(team: TeamState) {
  return team.bots.filter(bot => !botHistorySessionId(team, bot)).map(bot => {
    const task = team.tasks.find(task => task.assigneeBotId === bot.id && !['done', 'cancelled'].includes(task.status));
    const operation = task && team.operations.find(op => op.type === 'spawn' && op.botId === bot.id && op.attemptId === task.currentAttemptId);
    return { bot, task, failed: !!operation && ['failed', 'unknown'].includes(operation.status), href: `/teams/${encodeURIComponent(team.id)}${task ? `?task=${encodeURIComponent(task.id)}` : ''}` };
  });
}
