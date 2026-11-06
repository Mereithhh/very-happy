import { describe, expect, it } from 'vitest';
import { defaultNewIssueAssignee, isCreateChord, isNewIssueKey, parseRemembered, rememberedFromCreate, showIssueGuide, type DefaultContext, type RememberedAssignee } from './newIssueDefaults';

const agent: RememberedAssignee = { kind: 'agent', machineId: 'm1', agent: 'claude', model: 'opus', directory: '/work/app', runDirectory: '/work/app', projectId: '' };
const online: DefaultContext['runnable'] = [{ machineId: 'm1', agents: ['claude', 'codex'] }];
const ctx = (over: Partial<DefaultContext> = {}): DefaultContext => ({ projectId: '', projectFolders: [], runnable: online, ...over });

describe('defaultNewIssueAssignee (B-896)', () => {
  it('first time (no record on this device): 无', () => {
    expect(defaultNewIssueAssignee(null, ctx())).toEqual({ kind: 'none' });
  });
  it('remembers the agent: machine, agent, directory and model', () => {
    expect(defaultNewIssueAssignee(agent, ctx())).toEqual({ kind: 'agent', machineId: 'm1', agent: 'claude', model: 'opus', directory: '/work/app' });
  });
  it('remembers 无 and 我', () => {
    expect(defaultNewIssueAssignee({ kind: 'none' }, ctx())).toEqual({ kind: 'none' });
    expect(defaultNewIssueAssignee({ kind: 'self' }, ctx())).toEqual({ kind: 'self' });
  });
  it('machine offline / worker stale (not runnable): back to 无', () => {
    expect(defaultNewIssueAssignee(agent, ctx({ runnable: [] }))).toEqual({ kind: 'none' });
    expect(defaultNewIssueAssignee(agent, ctx({ runnable: [{ machineId: 'm2', agents: ['claude'] }] }))).toEqual({ kind: 'none' });
  });
  it('agent no longer available on that machine: back to 无', () => {
    expect(defaultNewIssueAssignee(agent, ctx({ runnable: [{ machineId: 'm1', agents: ['codex'] }] }))).toEqual({ kind: 'none' });
  });
  it('no directory resolves (record without one, no project folder there): back to 无 — never a 400 issue_no_directory', () => {
    const noDir = { ...agent, directory: '', runDirectory: '' };
    expect(defaultNewIssueAssignee(noDir, ctx())).toEqual({ kind: 'none' });
    expect(defaultNewIssueAssignee(noDir, ctx({ projectId: 'p2', projectFolders: [{ machineId: 'm9', path: '/elsewhere' }] }))).toEqual({ kind: 'none' });
  });
  it('switching project: a project with a folder on that machine runs in it; the typed directory stays with its own project', () => {
    const fromP1 = { ...agent, directory: '/work/app/sub', runDirectory: '/work/app/sub', projectId: 'p1' };
    const p1 = ctx({ projectId: 'p1', projectFolders: [{ machineId: 'm1', path: '/work/app', primary: true }] });
    const p2 = ctx({ projectId: 'p2', projectFolders: [{ machineId: 'm1', path: '/work/other' }] });
    expect(defaultNewIssueAssignee(fromP1, p1)).toMatchObject({ kind: 'agent', directory: '/work/app/sub' });
    expect(defaultNewIssueAssignee(fromP1, p2)).toMatchObject({ kind: 'agent', directory: '' });
    // a project without a folder there falls back to the remembered directory
    expect(defaultNewIssueAssignee(fromP1, ctx({ projectId: 'p3', projectFolders: [{ machineId: 'm7', path: '/x' }] }))).toMatchObject({ kind: 'agent', directory: '/work/app/sub' });
  });
});

describe('rememberedFromCreate (B-896)', () => {
  const base = { machineId: 'm1', agent: 'claude' as const, model: '', directory: '', projectId: '', projectFolders: [] };
  it('records the directory the run resolves to, typed first, else the project folder on that machine', () => {
    expect(rememberedFromCreate({ ...base, kind: 'agent', directory: ' /a ' })).toMatchObject({ directory: '/a', runDirectory: '/a' });
    expect(rememberedFromCreate({ ...base, kind: 'agent', projectId: 'p1', projectFolders: [{ machineId: 'm2', path: '/b' }, { machineId: 'm1', path: '/c' }, { machineId: 'm1', path: '/d', primary: true }] }))
      .toMatchObject({ directory: '', runDirectory: '/d', projectId: 'p1' });
  });
  it('无 / 我 record only the kind', () => {
    expect(rememberedFromCreate({ ...base, kind: 'none' })).toEqual({ kind: 'none' });
    expect(rememberedFromCreate({ ...base, kind: 'self' })).toEqual({ kind: 'self' });
  });
  it('round-trips through storage; malformed records read as first time', () => {
    const rec = rememberedFromCreate({ ...base, kind: 'agent', directory: '/a', model: 'gpt' });
    expect(parseRemembered(JSON.stringify(rec))).toEqual(rec);
    expect(parseRemembered(undefined)).toBeNull();
    expect(parseRemembered('{oops')).toBeNull();
    expect(parseRemembered(JSON.stringify({ kind: 'agent', machineId: 'm1', agent: 'cursor' }))).toBeNull();
    expect(parseRemembered(JSON.stringify({ kind: 'agent', agent: 'claude' }))).toBeNull();
    // a record with its directory removed stays readable — and then defaults to 无
    const stripped = parseRemembered(JSON.stringify({ ...rec, directory: undefined, runDirectory: undefined }));
    expect(stripped).toMatchObject({ kind: 'agent', directory: '', runDirectory: '' });
    expect(defaultNewIssueAssignee(stripped, ctx())).toEqual({ kind: 'none' });
  });
});

describe('shortcuts (B-896)', () => {
  const key = (over: Partial<KeyboardEvent> = {}) => ({ key: 'c', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });
  const body = { tagName: 'BODY', closest: () => null };
  it('C opens 新建 issue outside text fields only', () => {
    expect(isNewIssueKey(key(), body)).toBe(true);
    expect(isNewIssueKey(key({ key: 'C' }), body)).toBe(true);
    expect(isNewIssueKey(key(), { tagName: 'INPUT' })).toBe(false);
    expect(isNewIssueKey(key(), { tagName: 'TEXTAREA' })).toBe(false);
    expect(isNewIssueKey(key(), { tagName: 'DIV', isContentEditable: true })).toBe(false);
    expect(isNewIssueKey(key(), { tagName: 'BUTTON', closest: (sel: string) => (sel.includes('dialog') ? {} : null) })).toBe(false);
  });
  it('browser chords and IME composition pass through', () => {
    expect(isNewIssueKey(key({ metaKey: true }), body)).toBe(false);
    expect(isNewIssueKey(key({ ctrlKey: true }), body)).toBe(false);
    expect(isNewIssueKey(key({ isComposing: true }), body)).toBe(false);
    expect(isNewIssueKey({ ...key(), keyCode: 229 }, body)).toBe(false);
    expect(isNewIssueKey(key({ key: 'x' }), body)).toBe(false);
  });
  it('⌘↵ / Ctrl+↵ creates, plain Enter and composing Enter do not', () => {
    expect(isCreateChord({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isCreateChord({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true);
    expect(isCreateChord({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isCreateChord({ key: 'Enter', metaKey: true, ctrlKey: false, isComposing: true })).toBe(false);
    expect(isCreateChord({ key: 'Enter', metaKey: true, ctrlKey: false, keyCode: 229 })).toBe(false);
  });
});

describe('showIssueGuide (B-896)', () => {
  it('only on the unfiltered 全部 tab, once loaded, with nothing open', () => {
    expect(showIssueGuide({ tab: 'all', filtered: false, loaded: true, openCount: 0 })).toBe(true);
    expect(showIssueGuide({ tab: 'all', filtered: false, loaded: true, openCount: 1 })).toBe(false);
    expect(showIssueGuide({ tab: 'all', filtered: true, loaded: true, openCount: 0 })).toBe(false);
    expect(showIssueGuide({ tab: 'waiting', filtered: false, loaded: true, openCount: 0 })).toBe(false);
    expect(showIssueGuide({ tab: 'all', filtered: false, loaded: false, openCount: 0 })).toBe(false);
  });
});
