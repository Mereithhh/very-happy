import { describe, expect, it } from 'vitest';
import { compactCreateRows } from './sidebarTopVariant';

describe('compactCreateRows', () => {
  it('a new account keeps both labelled rows', () => {
    expect(compactCreateRows({ projectsReady: true, projectCount: 0, teamsVisible: true, teamCount: 0 })).toEqual(['new-project', 'new-team']);
  });
  it('each row disappears once the account has one', () => {
    expect(compactCreateRows({ projectsReady: true, projectCount: 2, teamsVisible: true, teamCount: 0 })).toEqual(['new-team']);
    expect(compactCreateRows({ projectsReady: true, projectCount: 2, teamsVisible: true, teamCount: 1 })).toEqual([]);
  });
  it('follows the same gates as the entries themselves', () => {
    expect(compactCreateRows({ projectsReady: false, projectCount: 0, teamsVisible: false, teamCount: 0 })).toEqual([]);
  });
});
