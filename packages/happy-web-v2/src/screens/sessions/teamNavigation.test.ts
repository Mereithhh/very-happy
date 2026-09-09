import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { groupTeamNavigation, teamSessionMembership, botHistorySessionId, missingTeamSessionIds, unstartedTeamMembers } from './teamNavigation';
const team = (id: string, sessionIds: string[]): TeamState => ({ id, name: id, machineId: 'm', version: 1, createdAt: 1, bots: sessionIds.map((sessionId, i) => ({ id: `${id}-${i}`, sessionId, name: `Member ${i}`, generation: 1, root: i === 0, managed: true, assistant: 'claude', directory: null })), tasks: [], operations: [], messages: [] });
describe('team history', () => {
  const rows = ['ordinary-a', 'lead', 'ordinary-b', 'member', 'ordinary-c'].map((sessionId) => ({ sessionId }));
  it('leaves every ordinary row unchanged without teams', () => {
    expect(groupTeamNavigation(rows, [], new Set()).map((e) => e.kind === 'row' && e.row)).toEqual(rows);
  });
  it('groups only explicit membership, keeps ordinary order and expands children in visual keyboard order', () => {
    const t = team('team', ['lead', 'member']);
    const nav = groupTeamNavigation(rows, [t], new Set(['team']));
    expect(nav.map((e) => e.kind === 'team' ? e.team.id : e.row.sessionId)).toEqual(['ordinary-a', 'team', 'lead', 'member', 'ordinary-b', 'ordinary-c']);
    expect(groupTeamNavigation(rows, [t], new Set()).map((e) => e.kind === 'team' ? e.team.id : e.row.sessionId)).toEqual(['ordinary-a', 'team', 'ordinary-b', 'ordinary-c']);
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
    expect(groupTeamNavigation(history.map(sessionId => ({ sessionId })), [t], new Set([t.id])).map(entry => entry.kind === 'team' ? entry.team.id : entry.row.sessionId)).toEqual(['completed', 'old-session']);
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
