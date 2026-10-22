import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { bucketItems, injectionStateOf, summarizeInjection, utf8Bytes, repairWorktreeFolders, worktreeFolders } from './projectPage';

describe('injection badge (准则 1: every harness shows its real state)', () => {
  it('no project-v1 → 未注入; restart helps only for injectable harnesses', () => {
    expect(injectionStateOf({ capabilities: ['prompt-queue-v1'], flavor: 'claude' }, undefined, 3)).toEqual({ kind: 'none', restartHelps: true });
    expect(injectionStateOf({ capabilities: [], flavor: 'openclaw' }, undefined, 3)).toEqual({ kind: 'none', restartHelps: false });
    expect(injectionStateOf({ flavor: undefined }, undefined, 3)).toEqual({ kind: 'none', restartHelps: false });
  });
  it('capable: current / stale / pending from the wrapper presence', () => {
    const meta = { capabilities: ['project-v1'], flavor: 'codex' };
    expect(injectionStateOf(meta, { injectedInstructionsVersion: 3, capabilities: [] }, 3)).toEqual({ kind: 'current', version: 3 });
    expect(injectionStateOf(meta, { injectedInstructionsVersion: 2, capabilities: [] }, 3)).toEqual({ kind: 'stale', version: 2, latest: 3 });
    expect(injectionStateOf(meta, { injectedInstructionsVersion: null, capabilities: [] }, 3)).toEqual({ kind: 'pending' });
    expect(injectionStateOf(meta, undefined, 0)).toEqual({ kind: 'pending' });
  });
  it('falls back to presence capabilities when this browser has no metadata; unknown when nothing', () => {
    expect(injectionStateOf(null, { injectedInstructionsVersion: 1, capabilities: ['project-v1'] }, 1)).toEqual({ kind: 'current', version: 1 });
    expect(injectionStateOf(null, undefined, 1)).toEqual({ kind: 'unknown' });
  });
  it('summarizes', () => {
    expect(summarizeInjection([{ kind: 'current', version: 1 }, { kind: 'none', restartHelps: true }, { kind: 'none', restartHelps: false }])).toEqual({ current: 1, stale: 0, pending: 0, none: 2, unknown: 0 });
  });
});

describe('overview buckets', () => {
  it('等你处理 = the shared attention set, then running, then idle; only project items', () => {
    const items = [{ key: 'a', lifecycle: 'waiting' }, { key: 'b', lifecycle: 'running' }, { key: 'c', lifecycle: 'waiting' }, { key: 'x', lifecycle: 'running' }];
    const b = bucketItems(items, new Set(['a', 'b', 'c']), new Set(['a', 'x']));
    expect(b.attention.map(i => i.key)).toEqual(['a']);
    expect(b.running.map(i => i.key)).toEqual(['b']);
    expect(b.idle.map(i => i.key)).toEqual(['c']);
  });
  it('utf8 byte count for the 8KB cap', () => {
    expect(utf8Bytes('ab')).toBe(2);
    expect(utf8Bytes('项目')).toBe(6);
  });
});

describe('B-755 worktree project folders', () => {
  const wt = '/home/u/.happy/teams/worktrees/wt-0001';
  const teams = [{ id: 't', machineId: 'm', operations: [{ id: 'wt-0001', type: 'spawn', directory: '/code/app' }] }] as unknown as TeamState[];
  it('lists worktree folders with their repository when a loaded team knows it', () => {
    expect(worktreeFolders([{ machineId: 'm', path: wt, primary: true }, { machineId: 'm', path: '/code/x', primary: false }, { machineId: 'm', path: '/h/.happy/teams/worktrees/gone', primary: false }], teams))
      .toEqual([{ machineId: 'm', path: wt, repository: '/code/app' }, { machineId: 'm', path: '/h/.happy/teams/worktrees/gone', repository: null }]);
  });
  it('repair swaps in the repository, keeps unknown ones, deduplicates and keeps the primary', () => {
    expect(repairWorktreeFolders([{ machineId: 'm', path: '/code/app', primary: false }, { machineId: 'm', path: wt, primary: true }, { machineId: 'm', path: '/h/.happy/teams/worktrees/gone', primary: false }], teams))
      .toEqual([{ machineId: 'm', path: '/code/app', primary: true }, { machineId: 'm', path: '/h/.happy/teams/worktrees/gone', primary: false }]);
  });
});
