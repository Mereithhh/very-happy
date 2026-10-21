import { teamBotActivity, teamMemberCounts, type TeamActivityContext, type TeamBot, type TeamState } from '@slopus/happy-wire';

/** A retired managed member keeps its immutable spawn receipt as a history link. */
export function botHistorySessionId(team: TeamState, bot: TeamBot): string | null {
  if (bot.sessionId) return bot.sessionId;
  return team.operations.filter(operation => operation.type === 'spawn' && operation.status === 'completed' && operation.botId === bot.id && operation.sessionId)
    .sort((a, b) => b.generation - a.generation || b.createdAt - a.createdAt)[0]?.sessionId ?? bot.previousSessionIds?.at(-1) ?? null;
}

/**
 * B-729: every conversation a team member has had belongs to that team — the
 * live binding, each completed spawn receipt (every generation of a reused
 * bot) and `previousSessionIds` (adopt / rebind / cleanup history). Only these
 * server-recorded fields count; titles and folders never do.
 *
 * A session claimed more than once gets ONE owner instead of being dropped —
 * dropping it showed a team's own conversation outside every team (prod
 * 10-22: roll-pool-cot's spawned Lead created roll-pool and joined it as lead).
 * Precedence: a live binding, then a spawn receipt, then other history; on a
 * tie the newer team wins — a conversation joins teams over time, so the latest
 * team is the role it has now (the other team's row still opens it as its
 * lead, B-721). Deterministic, so every view agrees.
 */
export function teamSessionMembership(teams: TeamState[]) {
  type Claim = { team: TeamState; bot: TeamBot; rank: number };
  const claims = new Map<string, Claim>();
  const better = (a: Claim, b: Claim) => a.rank !== b.rank ? a.rank < b.rank : a.team.createdAt !== b.team.createdAt ? a.team.createdAt > b.team.createdAt : a.team.id > b.team.id;
  const register = (sessionId: string, team: TeamState, bot: TeamBot, rank: number) => {
    const previous = claims.get(sessionId);
    if (!previous || better({ team, bot, rank }, previous)) claims.set(sessionId, { team, bot, rank });
  };
  for (const team of teams) for (const bot of team.bots) {
    if (bot.sessionId) register(bot.sessionId, team, bot, 0);
    for (const operation of team.operations) {
      if (operation.botId === bot.id && operation.type === 'spawn' && operation.status === 'completed' && operation.sessionId) register(operation.sessionId, team, bot, 1);
    }
    for (const sessionId of bot.previousSessionIds ?? []) register(sessionId, team, bot, 2);
  }
  const memberships = new Map<string, { team: TeamState; bot: TeamBot }>();
  for (const [sessionId, { team, bot }] of claims) memberships.set(sessionId, { team, bot });
  return memberships;
}

/** B-729: a conversation from an earlier generation of a member (its bot has
 *  moved on to a newer one) folds with the inactive members. */
export function teamSessionSuperseded(team: TeamState, bot: TeamBot, sessionId: string): boolean {
  const current = botHistorySessionId(team, bot);
  return !!current && current !== sessionId;
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

/** B-721: the lead's (root bot's) conversation — live or its latest spawn receipt. */
export function teamLeadSessionId(team: TeamState): string | null {
  const lead = team.bots.find(bot => bot.root);
  return lead ? botHistorySessionId(team, lead) : null;
}

/**
 * B-721: where a click on a sidebar team row goes. The lead's conversation
 * first (Owner: "点一下只想跟默认的负责人聊聊"); a team without one falls back
 * to its board. Ended / hibernated lead sessions still open — the session page
 * owns resume and leave-a-message.
 */
export function teamRowTarget(team: TeamState): { href: string; leadSessionId: string | null; boardHref: string } {
  const boardHref = `/teams/${encodeURIComponent(team.id)}`;
  const leadSessionId = teamLeadSessionId(team);
  return { href: leadSessionId ? `/session/${encodeURIComponent(leadSessionId)}` : boardHref, leadSessionId, boardHref };
}
