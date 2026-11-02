/**
 * B-868: web terminals in projects — the pure rules every surface relies on.
 * The project is the machine's `@vh_project` (pushed as `projectId`); the Web
 * only resolves and displays it. Store plumbing: sync/terminalSessions.project.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectMemberView, ProjectView } from '@slopus/happy-wire';
import type { MachineTerminal } from '@/sync/ops';
import { composeTerminalList, pruneOverlay, EMPTY_OVERLAY, RENAME_OVERLAY_TTL_MS, type MachinePush, type PushOverlay } from '@/sync/terminalPushOps';
import { terminalProjectsSupported } from '@/sync/closedTerminals';
import { terminalProjectResolver } from './sessionPlacement';
import { buildSidebarTree } from '@/screens/sessions/sidebarTree';
import { terminalProjectMenu } from '@/screens/projects/projectChoice';
import { buildProjectMenu } from '@/screens/projects/projectMenu';
import { buildSessionMenu } from './sessionMenu';
import { terminalPassesFilters, EMPTY_FILTERS } from '@/screens/search/sessionSearch';
import { newTerminalSearch, projectIdOfPath, terminalProjectParam } from './newTerminalSearch';

const NOW = 1_800_000_000_000;
const PID = '3f2c1a9e-8b7d-4c6e-9f00-112233445566';
const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra }) as unknown as ProjectView;
const member = (projectId: string, sessionId: string): ProjectMemberView => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: 1 }) as ProjectMemberView;
const push = (terminals: MachineTerminal[]): Record<string, MachinePush> => ({ m1: { machineName: 'box', terminals, updatedAt: NOW } });

describe('B-868 pushed projectId', () => {
  it('string = project, null = none (new CLI), absent = old CLI', () => {
    const rows = composeTerminalList(push([
      { id: 'a', projectId: PID }, { id: 'b', projectId: null }, { id: 'c' }, { id: 'd', projectId: 42 as unknown as string },
    ]), EMPTY_OVERLAY, NOW);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.projectId]))).toEqual({ a: PID, b: null, c: undefined, d: undefined });
  });

  it('a move shows at once and stays until the push confirms it, then the overlay is dropped', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, renames: { a: { projectId: PID, at: NOW } } };
    const before = push([{ id: 'a', projectId: null }]);
    expect(composeTerminalList(before, overlay, NOW)[0].projectId).toBe(PID);
    expect(pruneOverlay(overlay, before, NOW).renames.a).toBeDefined();
    expect(pruneOverlay(overlay, push([{ id: 'a', projectId: PID }]), NOW).renames.a).toBeUndefined();
    // Never confirmed (machine offline): honest revert after the TTL.
    expect(pruneOverlay(overlay, before, NOW + RENAME_OVERLAY_TTL_MS + 1).renames.a).toBeUndefined();
    // 移出 is a move to null — confirmed by a push that says null.
    const out: PushOverlay = { ...EMPTY_OVERLAY, renames: { a: { projectId: null, at: NOW } } };
    expect(composeTerminalList(push([{ id: 'a', projectId: PID }]), out, NOW)[0].projectId).toBeNull();
    expect(pruneOverlay(out, push([{ id: 'a', projectId: null }]), NOW).renames.a).toBeUndefined();
  });

  it('capability: only a flag stamped by the CURRENT daemon run counts', () => {
    expect(terminalProjectsSupported({ startedAt: 10, terminalProjects: { rpcAvailable: true, detectedAt: 10 } })).toBe(true);
    expect(terminalProjectsSupported({ startedAt: 20, terminalProjects: { rpcAvailable: true, detectedAt: 10 } })).toBe(false); // downgraded daemon
    expect(terminalProjectsSupported({ startedAt: 10 })).toBe(false); // old CLI
  });
});

describe('B-868 where a terminal sits', () => {
  const projects = [project('p1'), project('p2'), project('gone', { archivedAt: 5 } as Partial<ProjectView>)];
  const resolve = terminalProjectResolver(projects, [member('p2', 'mirror-1')], []);

  it('own project wins while live; otherwise its mirror session decides; unknown / archived = none', () => {
    expect(resolve({ projectId: 'p1' })).toBe('p1');
    expect(resolve({ projectId: 'p1', mirrorSessionId: 'mirror-1' })).toBe('p1');
    expect(resolve({ projectId: null, mirrorSessionId: 'mirror-1' })).toBe('p2');
    expect(resolve({ projectId: 'gone' })).toBeNull();
    expect(resolve({ projectId: 'deleted-elsewhere' })).toBeNull();
    expect(resolve({})).toBeNull();
  });

  it('the sidebar tree files a terminal row under its project, and back under 不在项目中 once removed', () => {
    const rows = [
      { key: 't:a', ownProjectId: 'p1', machineId: 'm', workspacePath: '/w', ts: NOW },
      { key: 's1', sessionId: 's1', machineId: 'm', workspacePath: '/w', ts: NOW },
    ];
    const tree = buildSidebarTree({ rows, projects, members: [], teams: [], needsYou: () => false });
    expect(tree.projects.find((g) => g.project?.id === 'p1')!.rows.map((r) => r.key)).toEqual(['t:a']);
    expect(tree.unassigned!.rows.map((r) => r.key)).toEqual(['s1']);
    const after = buildSidebarTree({ rows: [{ ...rows[0], ownProjectId: null }, rows[1]], projects, members: [], teams: [], needsYou: () => false });
    expect(after.projects.find((g) => g.project?.id === 'p1')!.rows).toEqual([]);
    expect(after.unassigned!.rows.map((r) => r.key)).toEqual(['t:a', 's1']);
  });
});

describe('B-868 menus', () => {
  const snap = { status: 'ready', projects: [project('p1', { name: 'Alpha' })] };

  it('terminal row: 移到项目… / 换项目… + 从「X」移出, like a session', () => {
    expect(terminalProjectMenu({ projectId: null }, snap, { supported: true, zh: true })).toEqual({ move: '移到项目…', moveDisabled: false, leave: null });
    expect(terminalProjectMenu({ projectId: 'p1' }, snap, { supported: true, zh: true })).toEqual({ move: '换项目…', moveDisabled: false, leave: { projectId: 'p1', label: '从「Alpha」移出' } });
    expect(terminalProjectMenu({ projectId: 'p1' }, snap, { supported: true, zh: false }).leave!.label).toBe('Remove from "Alpha"');
  });

  it('old CLI: the entry is shown disabled with an update hint, and offers no 移出', () => {
    const zh = terminalProjectMenu({ projectId: undefined }, snap, { supported: false, zh: true });
    expect(zh).toEqual({ move: '移到项目…（需升级 CLI）', moveDisabled: true, leave: null });
    expect(terminalProjectMenu({}, snap, { supported: false, zh: false }).move).toBe('Move to project… (update the CLI)');
    const items = buildSessionMenu({ t: (k: string) => k, zh: true, isTerminal: true, project: zh, onMoveToProject: () => {} });
    expect(items.find((i) => i.key === 'move-project')).toMatchObject({ label: '移到项目…（需升级 CLI）', disabled: true });
  });

  it('nothing while projects are unavailable', () => {
    expect(terminalProjectMenu({ projectId: 'p1' }, { status: 'unavailable', projects: [] }, { supported: true, zh: true }).move).toBeNull();
  });

  it('the project menu offers 新建终端 (disabled for an archived project)', () => {
    const menu = buildProjectMenu({ zh: true, onNewSession: () => {}, onNewTerminal: () => {}, onSettings: () => {}, onRename: () => {}, onArchive: () => {} });
    expect(menu.map((i) => i.key).slice(0, 2)).toEqual(['new-session', 'new-terminal']);
    expect(buildProjectMenu({ zh: false, archived: true, onNewSession: () => {}, onNewTerminal: () => {}, onSettings: () => {}, onRename: () => {}, onArchive: () => {} })
      .find((i) => i.key === 'new-terminal')).toMatchObject({ label: 'New terminal', disabled: true });
  });
});

describe('B-868 ⌘K project filter', () => {
  it('a terminal passes the project chip only when it resolves to that project', () => {
    const f = { ...EMPTY_FILTERS, projectId: 'p1' };
    expect(terminalPassesFilters({ machineId: 'm', projectId: 'p1' }, f)).toBe(true);
    expect(terminalPassesFilters({ machineId: 'm', projectId: null }, f)).toBe(false);
    expect(terminalPassesFilters({ machineId: 'm', projectId: null }, EMPTY_FILTERS)).toBe(true);
    expect(terminalPassesFilters({ machineId: 'm', projectId: 'p1' }, { ...EMPTY_FILTERS, machineId: 'other' })).toBe(false);
    expect(terminalPassesFilters({ machineId: 'm', projectId: 'p1' }, { ...EMPTY_FILTERS, status: 'archived' })).toBe(false);
  });
});

describe('B-868 create inside a project', () => {
  it('the fresh-create URL carries a validated project id (attach included)', () => {
    expect(newTerminalSearch('abc', { cwd: '/w', projectId: PID }).get('project')).toBe(PID);
    expect(newTerminalSearch('abc', { attachTmux: { id: '$3', name: 'dev' }, projectId: PID }).get('project')).toBe(PID);
    expect(newTerminalSearch('abc', { projectId: '../x' }).has('project')).toBe(false);
    expect(newTerminalSearch('abc').has('project')).toBe(false);
    expect(terminalProjectParam('a b')).toBeUndefined();
  });

  it('the project page in view decides the default project', () => {
    expect(projectIdOfPath(`/projects/${PID}`)).toBe(PID);
    expect(projectIdOfPath(`/projects/${PID}/settings`)).toBe(PID);
    expect(projectIdOfPath('/projects')).toBeUndefined();
    expect(projectIdOfPath('/session/abc')).toBeUndefined();
    expect(projectIdOfPath('/projects/%E0%A4%A')).toBeUndefined(); // malformed escape
  });
});
