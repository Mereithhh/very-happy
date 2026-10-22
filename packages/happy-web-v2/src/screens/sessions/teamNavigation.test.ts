import { describe, expect, it } from 'vitest';
import { TEAM_MEMBER_IDLE_MS, type TeamState } from '@slopus/happy-wire';
import { groupTeamNavigation, teamSessionMembership, teamSessionSuperseded, botHistorySessionId, missingTeamSessionIds, unstartedTeamMembers, teamInactiveGroupId, teamMemberInactive, teamMemberCount, teamRoster, teamHomeDirectory, isTeamWorktreePath, type TeamNavigationEntry } from './teamNavigation';
import { defaultCollapsed } from './sidebarCollapsedGroups';
const label = (e: TeamNavigationEntry<{ sessionId: string }>) => e.kind === 'row' ? e.row.sessionId : e.kind === 'team' ? e.team.id : `inactive:${e.count}:${e.open ? 'open' : 'closed'}`;
const team = (id: string, sessionIds: string[]): TeamState => ({ id, name: id, machineId: 'm', version: 1, createdAt: 1, bots: sessionIds.map((sessionId, i) => ({ id: `${id}-${i}`, sessionId, name: `Member ${i}`, generation: 1, root: i === 0, managed: true, assistant: 'claude', directory: null })), tasks: [], operations: [], messages: [] });
describe('team history', () => {
  const rows = ['ordinary-a', 'lead', 'ordinary-b', 'member', 'ordinary-c'].map((sessionId) => ({ sessionId }));
  it('leaves every ordinary row unchanged without teams', () => {
    expect(groupTeamNavigation(rows, [], new Set()).map((e) => e.kind === 'row' && e.row)).toEqual(rows);
  });
  it('groups only explicit membership, keeps ordinary order and expands children in visual keyboard order', () => {
    const t = team('team', ['lead', 'member']);
    const nav = groupTeamNavigation(rows, [t], new Set(['team']));
    expect(nav.map(label)).toEqual(['ordinary-a', 'team', 'lead', 'member', 'ordinary-b', 'ordinary-c']);
    expect(groupTeamNavigation(rows, [t], new Set()).map(label)).toEqual(['ordinary-a', 'team', 'ordinary-b', 'ordinary-c']);
  });
  it('keeps newly created teams reachable before a session exists', () => {
    expect(groupTeamNavigation([], [team('preparing', [])], new Set())).toEqual([{ kind: 'team', team: team('preparing', []) }]);
  });
  it('B-729: a session claimed by several teams belongs to exactly one (newer team on a tie) instead of none', () => {
    expect(teamSessionMembership([team('one', ['lead']), { ...team('two', ['lead']), createdAt: 2 }]).get('lead')?.team.id).toBe('two');
  });
});


describe('retired member history', () => {
  function completedTeam(): TeamState {
    const t = team('completed', ['old-session']);
    t.bots[0].sessionId = null;
    t.operations = [{ id: 'spawn', teamId: t.id, machineId: 'm', taskId: 'task', botId: t.bots[0].id, attemptId: 'attempt', generation: 1, type: 'spawn', status: 'completed', claimId: 'claim', claimedAt: 1, error: null, sessionId: 'old-session', directory: '/repo', assistant: 'claude', prompt: 'goal', createdAt: 1 }];
    return t;
  }
  it('retains read-only navigation after cleanup clears the active binding', () => {
    const t = completedTeam();
    expect(botHistorySessionId(t, t.bots[0])).toBe('old-session');
    expect(teamSessionMembership([t]).get('old-session')?.team.id).toBe(t.id);
    const history = missingTeamSessionIds(new Set(['ordinary-live']), [t]);
    expect(history).toEqual(['old-session']);
    expect(groupTeamNavigation(history.map(sessionId => ({ sessionId })), [t], new Set([t.id])).map(label)).toEqual(['completed', 'old-session']);
    expect(t.bots[0].sessionId).toBeNull();
  });
  it('prefers a live binding, preserves older attempts and does not duplicate current receipts', () => {
    const t = completedTeam();
    t.operations.push({ ...t.operations[0], id: 'new-spawn', generation: 2, sessionId: 'new-session', createdAt: 2 });
    expect(botHistorySessionId(t, t.bots[0])).toBe('new-session');
    t.bots[0].sessionId = 'new-session';
    expect([...teamSessionMembership([t]).keys()].sort()).toEqual(['new-session', 'old-session']);
    expect(missingTeamSessionIds(new Set(['new-session']), [t])).toEqual(['old-session']);
  });
  it('never associates a stopped receipt with a team; a live binding elsewhere outranks a receipt (B-729)', () => {
    const t = completedTeam();
    const other = { ...team('other', ['old-session']), createdAt: 0 }; // older: rank, not age, decides
    expect(teamSessionMembership([t, other]).get('old-session')?.team.id).toBe('other');
    t.operations[0].type = 'stop';
    expect(botHistorySessionId(t, t.bots[0])).toBeNull();
    expect(missingTeamSessionIds(new Set(), [t])).toEqual([]);
  });
});

it('shows a failed sessionless member with its task link and stops duplicating it once connected', () => {
 const t=team('t',['']); t.bots[0].sessionId=null;
 t.tasks=[{id:'task',parentTaskId:null,goal:'goal',acceptance:[],goalVersion:1,ownerBotId:null,assigneeBotId:t.bots[0].id,status:'queued',attempts:[],currentAttemptId:'attempt',cleanup:'none'}];
 t.operations=[{id:'op',teamId:t.id,machineId:'m',taskId:'task',botId:t.bots[0].id,attemptId:'attempt',generation:1,type:'spawn',status:'failed',claimId:'claim',claimedAt:1,error:'invalid path',sessionId:null,directory:'~/repo',assistant:'claude',prompt:'',createdAt:1}];
 expect(unstartedTeamMembers(t).map(m=>[m.bot.id,m.failed,m.href])).toEqual([['t-0',true,'/teams/t?task=task']]);
 t.bots[0].sessionId='started'; expect(unstartedTeamMembers(t)).toEqual([]);
});

describe('B-674/B-690 inactive team members fold', () => {
  const rows = ['ordinary', 'lead', 'old-1', 'member', 'old-2'].map((sessionId) => ({ sessionId }));
  const t = team('team', ['lead', 'old-1', 'member', 'old-2']);
  const isInactive = (r: { sessionId: string }) => r.sessionId.startsWith('old-');
  it('lists live members, then folds archived ones behind a single count row (closed by default)', () => {
    expect(groupTeamNavigation(rows, [t], new Set(['team']), { isInactive, open: new Set() }).map(label))
      .toEqual(['ordinary', 'team', 'lead', 'member', 'inactive:2:closed']);
  });
  it('shows archived members after the fold row when that team is opened', () => {
    expect(groupTeamNavigation(rows, [t], new Set(['team']), { isInactive, open: new Set(['team']) }).map(label))
      .toEqual(['ordinary', 'team', 'lead', 'member', 'inactive:2:open', 'old-1', 'old-2']);
  });
  it('adds no fold row when nothing is archived, and nothing at all while the team is collapsed', () => {
    expect(groupTeamNavigation(rows, [t], new Set(['team']), { isInactive: () => false, open: new Set() }).map(label))
      .toEqual(['ordinary', 'team', 'lead', 'old-1', 'member', 'old-2']);
    expect(groupTeamNavigation(rows, [t], new Set(), { isInactive, open: new Set(['team']) }).map(label)).toEqual(['ordinary', 'team']);
  });
  it('remembers the fold per device under a key that defaults to collapsed', () => {
    expect(teamInactiveGroupId('team')).toBe('team-archived:team');
    expect(defaultCollapsed(teamInactiveGroupId('team'))).toBe(true);
    expect(defaultCollapsed('project:p1')).toBe(false);
  });
});

describe('B-690 one rule for 「已停用」 members', () => {
  const now = 10 * TEAM_MEMBER_IDLE_MS;
  const base = () => {
    const t = team('t', ['s-lead', 's-worker']);
    t.bots[1].lastEvent = 'idle'; t.bots[1].lastEventAt = now - 1000;
    return t;
  };
  const task = (assigneeBotId: string, status: TeamState['tasks'][number]['status']) => ({ id: `${assigneeBotId}-${status}`, parentTaskId: null, goal: 'g', acceptance: [], goalVersion: 1, ownerBotId: null, assigneeBotId, status, attempts: [], currentAttemptId: 'a', cleanup: 'none' as const });
  it('keeps a recently active member with a session active', () => {
    const t = base();
    expect(teamMemberInactive(t, t.bots[1], { now, sessionArchived: () => false })).toBe(false);
  });
  it('B-674 case: an archived conversation is inactive', () => {
    const t = base();
    expect(teamMemberInactive(t, t.bots[1], { now, sessionArchived: () => true })).toBe(true);
  });
  it('stopped (no session), exited, or idle past the threshold is inactive', () => {
    const stopped = base(); stopped.bots[1].sessionId = null;
    expect(teamMemberInactive(stopped, stopped.bots[1], { now, sessionArchived: () => false })).toBe(true);
    const exited = base(); exited.bots[1].lastEvent = 'exited';
    expect(teamMemberInactive(exited, exited.bots[1], { now, sessionArchived: () => false })).toBe(true);
    const idle = base(); idle.bots[1].lastEventAt = now - TEAM_MEMBER_IDLE_MS - 1;
    expect(teamMemberInactive(idle, idle.bots[1], { now, sessionArchived: () => false })).toBe(true);
    const fresh = base(); fresh.bots[1].lastEventAt = now - TEAM_MEMBER_IDLE_MS + 1;
    expect(teamMemberInactive(fresh, fresh.bots[1], { now, sessionArchived: () => false })).toBe(false);
  });
  it('an open task (queued / running / submitted) always keeps the member active, even archived or stopped', () => {
    for (const status of ['queued', 'running', 'submitted'] as const) {
      const t = base(); t.bots[1].sessionId = null; t.bots[1].lastEvent = 'exited'; t.tasks = [task(t.bots[1].id, status)];
      expect(teamMemberInactive(t, t.bots[1], { now, sessionArchived: () => true })).toBe(false);
    }
    const done = base(); done.bots[1].sessionId = null; done.tasks = [task(done.bots[1].id, 'done'), task(done.bots[1].id, 'cancelled')];
    expect(teamMemberInactive(done, done.bots[1], { now, sessionArchived: () => false })).toBe(true);
  });
  it('a session with no recorded event stays active (no evidence it stopped)', () => {
    const t = base(); delete t.bots[1].lastEvent; delete t.bots[1].lastEventAt;
    expect(teamMemberInactive(t, t.bots[1], { now, sessionArchived: () => false })).toBe(false);
  });
  it('the member count leaves inactive members out (archived input from the Web)', () => {
    const t = base(); t.bots.push({ ...t.bots[1], id: 't-2', sessionId: 's-old' });
    expect(teamMemberCount(t, { now, sessionArchived: (id) => id === 's-old' })).toBe(2);
    expect(teamMemberCount(t, { now })).toBe(3);
  });
  it('folds sessionless inactive members into the same count via `extra`', () => {
    const t = team('team', ['lead']);
    const rows = [{ sessionId: 'lead' }];
    expect(groupTeamNavigation(rows, [t], new Set(['team']), { isInactive: () => false, open: new Set(), extra: () => 2 }).map(label))
      .toEqual(['team', 'lead', 'inactive:2:closed']);
  });
});

describe('B-723', () => {
  const b = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, sessionId: `s-${id}`, generation: 1, root: false, managed: true, assistant: 'claude', directory: null, ...extra });
  const t = (bots: ReturnType<typeof b>[], extra: Record<string, unknown> = {}) => ({ id: 't', name: 't', machineId: 'm', version: 1, bots, tasks: [], messages: [], operations: [], createdAt: 1, ...extra }) as unknown as TeamState;
  it('D1: teamRoster lists current members lead-first and counts inactive ones', () => {
    const team = t([b('w1'), b('gone', { lastEvent: 'exited' }), b('lead', { root: true }), b('none', { sessionId: null }), b('archived')]);
    const roster = teamRoster(team, { sessionArchived: id => id === 's-archived' });
    expect(roster.members.map(x => x.id)).toEqual(['lead', 'w1']);
    expect(roster.inactive).toBe(3);
  });
  it('O1: teamHomeDirectory prefers the launch repo and never returns a member worktree', () => {
    expect(teamHomeDirectory(t([b('lead', { root: true, directory: '/h/.happy/teams/worktrees/x' })], { creationLaunch: { directory: '/repo' } }))).toBe('/repo');
    expect(teamHomeDirectory(t([b('lead', { root: true, directory: '/h/.happy/teams/worktrees/x' })]))).toBeNull();
    expect(teamHomeDirectory(t([b('lead', { root: true, directory: '/repo3' })]))).toBe('/repo3');
    expect(isTeamWorktreePath('C:\\Users\\u\\.happy\\teams\\worktrees\\abc')).toBe(true);
    expect(isTeamWorktreePath('/home/u/code/teams/worktrees-notes')).toBe(false);
  });
  it('B-755: a team launched from another team\'s worktree is homed in that worktree\'s repository', () => {
    const op = (id: string, directory: string) => ({ id, type: 'spawn', botId: 'lead', directory, createdAt: 1 });
    const source = t([b('lead', { root: true, directory: '/h/.happy/teams/worktrees/f0747a90' })], { id: 'roll', creationLaunch: { directory: '/code/skills' }, operations: [op('f0747a90', '/code/skills')] });
    const nested = t([b('lead', { root: true, directory: '/h/.happy/teams/worktrees/801fecdb' })], { id: 'gov', creationLaunch: { directory: '/h/.happy/teams/worktrees/f0747a90' }, operations: [op('801fecdb', '/h/.happy/teams/worktrees/f0747a90')] });
    expect(teamHomeDirectory(nested, [source, nested])).toBe('/code/skills');
    // Without the source team loaded the worktree is never the answer.
    expect(teamHomeDirectory(nested)).toBeNull();
    // The lead's own worktree resolves through its own spawn operation.
    expect(teamHomeDirectory(t([b('lead', { root: true, directory: '/h/.happy/teams/worktrees/x' })], { operations: [op('x', '/repo')] }))).toBe('/repo');
  });
});

/**
 * B-729 (production 10-22): the roll-pool-cot Lead was spawned by roll-pool-cot
 * and then adopted as roll-pool's lead — claimed twice, it was dropped from
 * both and rendered outside every team. Every generation and role must nest.
 */
describe('B-729 every team conversation nests under its team', () => {
  const op = (teamId: string, botId: string, generation: number, sessionId: string, extra: Partial<TeamState['operations'][number]> = {}): TeamState['operations'][number] => ({ id: `${botId}-g${generation}`, teamId, machineId: 'm', taskId: 'task', botId, attemptId: `a${generation}`, generation, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: 1, error: null, sessionId, directory: '/repo', assistant: 'claude', prompt: '', createdAt: generation, ...extra });
  /** Lead (spawned), a reused worker (gen 1 → gen 2), its delegated sub-member, and an adopted second lead with an older rebind. */
  function devTeam(): TeamState {
    const t = team('dev', ['lead', 'worker-g2', 'sub']);
    t.bots[1].generation = 2;
    t.bots.push({ id: 'dev-adopted', name: 'Adopted', sessionId: 'adopted-now', generation: 2, root: true, managed: false, assistant: 'claude', directory: null, previousSessionIds: ['adopted-before'] });
    t.operations = [op('dev', 'dev-0', 1, 'lead'), op('dev', 'dev-1', 1, 'worker-g1'), op('dev', 'dev-1', 2, 'worker-g2'), op('dev', 'dev-2', 1, 'sub'), op('dev', 'dev-1', 1, 'worker-g1', { id: 'stop', type: 'stop' })];
    return t;
  }
  const all = ['lead', 'worker-g1', 'worker-g2', 'sub', 'adopted-now', 'adopted-before'];
  it('lead, every generation of a reused bot, sub-members and adopt history all belong to the team; unrelated sessions never do', () => {
    const m = teamSessionMembership([devTeam()]);
    expect(all.map(id => [id, m.get(id)?.team.id])).toEqual(all.map(id => [id, 'dev']));
    expect(m.get('worker-g1')?.bot.id).toBe('dev-1');
    expect(m.get('adopted-before')?.bot.id).toBe('dev-adopted');
    expect(m.has('ordinary')).toBe(false);
  });
  it('older generations fold behind 已停用 while the member\'s current conversation stays listed', () => {
    const t = devTeam();
    expect(teamSessionSuperseded(t, t.bots[1], 'worker-g1')).toBe(true);
    expect(teamSessionSuperseded(t, t.bots[1], 'worker-g2')).toBe(false);
    expect(teamSessionSuperseded(t, t.bots[3], 'adopted-before')).toBe(true);
    const rows = ['ordinary', ...all].map(sessionId => ({ sessionId }));
    const isInactive = (r: { sessionId: string }, team: TeamState, bot: TeamState['bots'][number] | undefined) => !!bot && teamSessionSuperseded(team, bot, r.sessionId);
    expect(groupTeamNavigation(rows, [t], new Set(['dev']), { isInactive, open: new Set() }).map(label))
      .toEqual(['ordinary', 'dev', 'lead', 'worker-g2', 'sub', 'adopted-now', 'inactive:2:closed']);
  });
  it('prod 10-22: a spawned Lead that created and joined a second team nests under that newer team, not outside both', () => {
    const cot = { ...team('roll-pool-cot', ['L', 'w']), createdAt: 1 };
    cot.operations = [op('roll-pool-cot', 'roll-pool-cot-0', 1, 'L')];
    const pool = { ...team('roll-pool', ['L', 'p']), createdAt: 2 }; // joined later as root (no receipt)
    pool.bots[0].managed = false;
    for (const order of [[pool, cot], [cot, pool]]) expect(teamSessionMembership(order).get('L')).toMatchObject({ team: { id: 'roll-pool' }, bot: { id: 'roll-pool-0' } });
    expect(groupTeamNavigation(['x', 'L', 'w', 'p'].map(sessionId => ({ sessionId })), [cot, pool], new Set(['roll-pool', 'roll-pool-cot'])).map(label))
      .toEqual(['x', 'roll-pool', 'L', 'p', 'roll-pool-cot', 'w']);
  });
  it('a retired member\'s session rejoined as a new lead of the same team keeps one row, labeled by its live binding', () => {
    const t = team('t', ['', 'reused']);
    t.bots[0].sessionId = null;
    t.operations = [op('t', 't-0', 1, 'reused')];
    expect(teamSessionMembership([t]).get('reused')?.bot.id).toBe('t-1');
  });
  it('a member with only adopt history still links its last conversation', () => {
    const t = team('t', ['']);
    t.bots[0] = { ...t.bots[0], sessionId: null, previousSessionIds: ['a1', 'a2'] };
    expect(botHistorySessionId(t, t.bots[0])).toBe('a2');
    expect(missingTeamSessionIds(new Set(['a2']), [t])).toEqual(['a1']);
  });
});
