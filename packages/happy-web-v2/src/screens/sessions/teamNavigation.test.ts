import { describe, expect, it } from 'vitest';
import { TEAM_MEMBER_IDLE_MS, type TeamState } from '@slopus/happy-wire';
import { groupTeamNavigation, teamSessionMembership, botHistorySessionId, missingTeamSessionIds, unstartedTeamMembers, teamInactiveGroupId, teamMemberInactive, teamMemberCount, teamRoster, teamHomeDirectory, isTeamWorktreePath, type TeamNavigationEntry } from './teamNavigation';
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
  it('does not hide a session claimed by multiple teams', () => {
    expect(teamSessionMembership([team('one', ['lead']), team('two', ['lead'])]).has('lead')).toBe(false);
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
  it('never associates a stopped receipt or an ambiguous historical session with a team', () => {
    const t = completedTeam();
    const other = team('other', ['old-session']);
    expect(teamSessionMembership([t, other]).has('old-session')).toBe(false);
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
});
