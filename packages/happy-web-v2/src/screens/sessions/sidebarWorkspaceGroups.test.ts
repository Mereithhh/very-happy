import { describe, expect, it } from 'vitest';
import { groupRowsByWorkspace, normalizeWorkspacePath, resolveSidebarGroupMode, workspaceBasename } from './sidebarWorkspaceGroups';

type R = {
  key: string;
  machineId?: string;
  machineName?: string;
  workspacePath?: string;
  sessionId?: string;
};

describe('workspace path identity (B-208)', () => {
  it('preserves the legacy tag-grouping choice across the local setting migration', () => {
    expect(resolveSidebarGroupMode('workspace', true)).toBe('tag');
    expect(resolveSidebarGroupMode('workspace', false)).toBe('workspace');
    expect(resolveSidebarGroupMode('none', false)).toBe('none');
  });

  it('normalizes POSIX/Windows separators without resolving path semantics', () => {
    expect(normalizeWorkspacePath('/code/happy///')).toBe('/code/happy');
    expect(normalizeWorkspacePath('C:\\code\\happy\\')).toBe('c:/code/happy');
    expect(normalizeWorkspacePath('/')).toBe('/');
    expect(normalizeWorkspacePath('C:\\')).toBe('c:/');
    expect(normalizeWorkspacePath('/code/../happy')).toBe('/code/../happy');
    expect(workspaceBasename('c:/code/happy')).toBe('happy');
  });

  it('joins chat and terminal only when machine and normalized cwd match', () => {
    const rows: R[] = [
      { key: 's1', sessionId: 's1', machineId: 'm1', machineName: 'Mac', workspacePath: '/code/happy/' },
      { key: 't1', machineId: 'm1', machineName: 'Mac', workspacePath: '/code/happy' },
      { key: 's2', sessionId: 's2', machineId: 'm2', machineName: 'Linux', workspacePath: '/code/happy' },
      { key: 's3', sessionId: 's3', machineId: 'm1', machineName: 'Mac', workspacePath: '/code/other' },
    ];
    const groups = groupRowsByWorkspace(rows);
    expect(groups.map((g) => g.rows.map((r) => r.key))).toEqual([
      ['s1', 't1'],
      ['s2'],
      ['s3'],
    ]);
    expect(groups[0].representativeSessionId).toBe('s1');
  });

  it('preserves first-seen order and finds a later representative session', () => {
    const groups = groupRowsByWorkspace<R>([
      { key: 't1', machineId: 'm1', workspacePath: '/b' },
      { key: 's1', sessionId: 's1', machineId: 'm1', workspacePath: '/b' },
      { key: 's2', sessionId: 's2', machineId: 'm1', workspacePath: '/a' },
    ]);
    expect(groups.map((g) => g.name)).toEqual(['b', 'a']);
    expect(groups[0].rows.map((r) => r.key)).toEqual(['t1', 's1']);
    expect(groups[0].representativeSessionId).toBe('s1');
  });

  it('keeps unknown rows separate, but groups unknown cwd per known machine', () => {
    const groups = groupRowsByWorkspace<R>([
      { key: 'legacy-a' },
      { key: 'legacy-b' },
      { key: 't1', machineId: 'm1' },
      { key: 't2', machineId: 'm1' },
    ]);
    expect(groups.map((g) => g.rows.map((r) => r.key))).toEqual([
      ['legacy-a'],
      ['legacy-b'],
      ['t1', 't2'],
    ]);
    expect(groups[2].representativeSessionId).toBeNull();
  });
});
