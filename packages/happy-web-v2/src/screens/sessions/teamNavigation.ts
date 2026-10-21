import { teamBotActivity, teamMemberCounts, type TeamActivityContext, type TeamBot, type TeamState } from '@slopus/happy-wire';

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

/**
 * B-690 — 「已停用」 members fold (sidebar and Teams page) by the ONE rule in
 * happy-wire (`teamBotActivity`, B-692): no unfinished task and any of no
 * session / archived session / last event `exited` / no event for 7 days; the
 * lead and an in-flight launch stay active, an unfinished cleanup is
 * `stopping` (「回收需要处理」, never folded). Only the Web knows which
 * sessions are archived, so callers pass that in.
 */
export function teamMemberInactive(team: TeamState, bot: TeamBot, context: TeamActivityContext): boolean {
  return teamBotActivity(team, bot, context) === 'inactive';
}
/** 成员数 = everyone but `inactive` (the 「已停用 M」 count). */
export function teamMemberCount(team: TeamState, context: TeamActivityContext): number {
  const counts = teamMemberCounts(team, context);
  return team.bots.length - counts.inactive;
}

/** B-723 (D1): the members a summary shows — never `inactive` ones (the
 *  happy-wire rule), lead first — plus how many were left out as 「已停用」. */
export function teamRoster(team: TeamState, context: TeamActivityContext): { members: TeamBot[]; inactive: number } {
  const members = team.bots.filter(bot => !teamMemberInactive(team, bot, context));
  return { members: [...members.filter(bot => bot.root), ...members.filter(bot => !bot.root)], inactive: team.bots.length - members.length };
}

/** Team daemons put every managed member in its own worktree under
 *  `<happy home>/teams/worktrees/<operation id>` (happy-cli daemon/teams/worktree.ts). */
export function isTeamWorktreePath(path: string): boolean {
  return /\/teams\/worktrees\/[^/]+\/?$/.test(path.replace(/\\/g, '/'));
}

/** B-723 (O1): the folder a team belongs to — the repository it was created
 *  in, never a member's worktree (whose UUID path changes with whoever ran
 *  last). Creation launch first, then the lead's requested spawn directory,
 *  then the lead's own directory when it is not a team worktree. */
export function teamHomeDirectory(team: TeamState): string | null {
  if (team.creationLaunch?.directory) return team.creationLaunch.directory;
  const root = team.bots.find(bot => bot.root);
  if (!root) return null;
  const spawn = team.operations.filter(op => op.type === 'spawn' && op.botId === root.id && op.directory).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (spawn?.directory && !isTeamWorktreePath(spawn.directory)) return spawn.directory;
  return root.directory && !isTeamWorktreePath(root.directory) ? root.directory : null;
}

/** A registered member is visible even before its first session exists. */
export function unstartedTeamMembers(team: TeamState) {
  return team.bots.filter(bot => !botHistorySessionId(team, bot)).map(bot => {
    const task = team.tasks.find(task => task.assigneeBotId === bot.id && !['done', 'cancelled'].includes(task.status));
    const operation = task && team.operations.find(op => op.type === 'spawn' && op.botId === bot.id && op.attemptId === task.currentAttemptId);
    return { bot, task, failed: !!operation && ['failed', 'unknown'].includes(operation.status), href: `/teams/${encodeURIComponent(team.id)}${task ? `?task=${encodeURIComponent(task.id)}` : ''}` };
  });
}
