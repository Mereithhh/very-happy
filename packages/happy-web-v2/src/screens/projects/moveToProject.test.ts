import { describe, expect, it } from 'vitest';
import { planMove } from './moveToProject';

const m = (projectId: string, sessionId: string, via = 'explicit') => ({ projectId, sessionId, via, machineId: null, createdAt: 1 });

describe('planMove', () => {
  it('moves only sessions not already in the target (one batch call)', () => {
    expect(planMove(['a', 'b', 'c', 'a'], 'p', [m('p', 'a'), m('q', 'b')])).toEqual({ add: { projectId: 'p', sessionIds: ['b', 'c'] }, remove: [] });
    expect(planMove(['a'], 'p', [m('p', 'a')])).toEqual({ add: null, remove: [] });
  });
  it('无项目 removes explicit memberships only (team members leave by detaching the team)', () => {
    expect(planMove(['a', 'b', 'c'], null, [m('p', 'a'), m('q', 'b', 'team')])).toEqual({ add: null, remove: [{ projectId: 'p', sessionId: 'a' }] });
  });
});
