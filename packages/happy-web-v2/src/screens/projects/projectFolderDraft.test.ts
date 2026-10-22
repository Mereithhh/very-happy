import { describe, expect, it } from 'vitest';
import { defaultNewFolder, folderProblem, newFolderBlocker, resolveProjectFolderDraft, type ProjectFolderDraft } from './projectFolderDraft';

const m = (extra: Record<string, unknown> = {}) => ({ id: 'm', metadata: { homeDir: '/home/u', fsMkdirVersion: 1, ...extra } });
const d = (extra: Partial<ProjectFolderDraft> = {}): ProjectFolderDraft => ({ machineId: 'm', mode: 'existing', path: '/home/u/code/app', gitInit: false, ...extra });

describe('B-755 project folder draft', () => {
  it('suggests ~/projects/<slug>, keeping CJK names', () => {
    expect(defaultNewFolder('My App!')).toBe('~/projects/my-app');
    expect(defaultNewFolder('订单看板')).toBe('~/projects/订单看板');
    expect(defaultNewFolder('  ')).toBe('~/projects/project');
  });
  it('「新建」 needs an online machine whose daemon serves fs-mkdir', () => {
    expect(newFolderBlocker(m(), true)).toBeNull();
    expect(newFolderBlocker(m(), false)).toBe('new-offline');
    expect(newFolderBlocker(m({ fsMkdirVersion: undefined }), true)).toBe('new-unsupported');
    expect(newFolderBlocker(undefined, true)).toBe('new-offline');
  });
  it('a project always has a folder; never a team worktree; a new one stays inside home without ..', () => {
    expect(folderProblem(d(), m(), true)).toBeNull();
    expect(folderProblem(d({ machineId: '' }), undefined, true)).toBe('machine');
    expect(folderProblem(d({ path: ' ' }), m(), true)).toBe('path');
    expect(folderProblem(d({ path: '/home/u/.happy/teams/worktrees/x' }), m(), true)).toBe('worktree');
    expect(folderProblem(d({ mode: 'new', path: '~/projects/a' }), m(), true)).toBeNull();
    expect(folderProblem(d({ mode: 'new', path: '/home/u/projects/a' }), m(), true)).toBeNull();
    expect(folderProblem(d({ mode: 'new', path: '~/projects/../../etc' }), m(), true)).toBe('dotdot');
    expect(folderProblem(d({ mode: 'new', path: '/etc/app' }), m(), true)).toBe('outside-home');
    expect(folderProblem(d({ mode: 'new', path: '~' }), m(), true)).toBe('outside-home');
    expect(folderProblem(d({ mode: 'new', path: '~/a' }), m(), false)).toBe('new-offline');
    expect(folderProblem(d({ mode: 'new', path: '~/a' }), m({ fsMkdirVersion: undefined }), true)).toBe('new-unsupported');
    // An existing folder works on an old daemon or offline machine (nothing is created).
    expect(folderProblem(d(), m({ fsMkdirVersion: undefined }), false)).toBeNull();
  });
  it('resolves an existing folder without the daemon and a new one through fs-mkdir', async () => {
    const never = async () => { throw new Error('must not create'); };
    expect(await resolveProjectFolderDraft(d({ path: '~/code/app' }), '/home/u', never)).toEqual({ ok: true, folder: { machineId: 'm', path: '/home/u/code/app' }, git: null });
    const calls: unknown[] = [];
    const ok = await resolveProjectFolderDraft(d({ mode: 'new', path: '~/projects/a', gitInit: true }), '/home/u', async (...args) => { calls.push(args); return { ok: true, path: '/home/u/projects/a', git: true }; });
    expect(ok).toEqual({ ok: true, folder: { machineId: 'm', path: '/home/u/projects/a' }, git: true });
    expect(calls).toEqual([['m', '~/projects/a', { gitInit: true }]]);
    expect(await resolveProjectFolderDraft(d({ mode: 'new', path: '~/x' }), '/home/u', async () => ({ ok: false, code: 'exists', error: 'exists' }))).toEqual({ ok: false, code: 'exists' });
  });
});
