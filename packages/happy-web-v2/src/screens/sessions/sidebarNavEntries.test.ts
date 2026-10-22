import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEW_TEAM_PATH, fitCapabilityRows, navAttentionTotal, navMenuLabel, orderCreateMenu, sidebarNavEntries, sidebarTopModel, splitCapabilities } from './sidebarNavEntries';

const all = { teamsVisible: true, automationsVisible: true, automationAttention: 0, incomingPeople: 0 };

describe('sidebarNavEntries (B-641)', () => {
  it('lists every capability entry in priority order with its route — 帮助 is not one (B-713: footer)', () => {
    expect(sidebarNavEntries(all).map((e) => [e.key, e.path])).toEqual([
      ['teams', '/teams'],
      ['automations', '/automations'],
      ['todos', '/todos'],
      ['people', '/people'],
    ]);
  });

  it('B-756: 项目 leads the entries once the projects API answered, and opens the /projects list', () => {
    expect(sidebarNavEntries({ ...all, projectsVisible: true }).map((e) => [e.key, e.path])[0]).toEqual(['projects', '/projects']);
    expect(sidebarNavEntries({ ...all, projectsVisible: false }).map((e) => e.key)).not.toContain('projects');
  });

  it('keeps the existing visibility gates for teams and automations', () => {
    const keys = sidebarNavEntries({ ...all, teamsVisible: false, automationsVisible: false }).map((e) => e.key);
    expect(keys).toEqual(['todos', 'people']);
  });

  it('a folded entry never hides a pending decision: the ⋯ total sums every count', () => {
    const entries = sidebarNavEntries({ ...all, automationAttention: 2, incomingPeople: 1 });
    expect(navAttentionTotal(entries)).toBe(3);
    expect(navAttentionTotal(sidebarNavEntries(all))).toBe(0);
    // a hidden automations entry contributes nothing
    expect(navAttentionTotal(sidebarNavEntries({ ...all, automationsVisible: false, automationAttention: 4 }))).toBe(0);
  });

  it('menu labels carry the count only when non-zero', () => {
    expect(navMenuLabel('自动化', 2)).toBe('自动化 · 2');
    expect(navMenuLabel('待办', 0)).toBe('待办');
  });
});

describe('sidebar top model (B-676, B-713)', () => {
  const base = { projectsReady: true, teamsVisible: true };
  it('desktop: no ⋯ — header 🔍 · collapse, then 新建会话 / 新建项目 / 新建团队 rows', () => {
    expect(sidebarTopModel({ isDesktop: true, ...base })).toEqual({ header: ['search', 'collapse'], actions: ['new-session', 'new-project', 'new-team'], chips: [] });
  });
  it('desktop drops 新建项目 without the projects API and 新建团队 when Teams is hidden', () => {
    expect(sidebarTopModel({ isDesktop: true, projectsReady: false, teamsVisible: true }).actions).toEqual(['new-session', 'new-team']);
    expect(sidebarTopModel({ isDesktop: true, projectsReady: true, teamsVisible: false }).actions).toEqual(['new-session', 'new-project']);
  });
  it('phone: header 🔍 · ＋ (B-641 create menu), one chip row 项目 · 团队 · 更多 and no action rows', () => {
    expect(sidebarTopModel({ isDesktop: false, ...base })).toEqual({ header: ['search', 'create-menu'], actions: [], chips: ['projects', 'teams', 'more'] });
    expect(sidebarTopModel({ isDesktop: false, projectsReady: false, teamsVisible: false }).chips).toEqual(['more']);
  });
  it('新建团队 opens the Teams create dialog directly', () => {
    expect(NEW_TEAM_PATH).toBe('/teams?new=1');
  });
  it('create menu: 新会话 first, 新项目 second, the rest in their given order', () => {
    const keys = orderCreateMenu([{ key: 'project' }, { key: 'chat' }, { key: 'advanced' }, { key: 'terminal' }, { key: 'connect-machine' }]).map((i) => i.key);
    expect(keys).toEqual(['chat', 'project', 'advanced', 'terminal', 'connect-machine']);
    expect(orderCreateMenu([{ key: 'chat' }, { key: 'terminal' }]).map((i) => i.key)).toEqual(['chat', 'terminal']);
  });
});

describe('capability rows fit the available height (B-713)', () => {
  const pitch = 34;
  it('shows every row when they all fit — no 更多能力 row then', () => {
    expect(fitCapabilityRows({ spare: 4 * pitch, rowPitch: pitch, total: 4 })).toBe(4);
    expect(fitCapabilityRows({ spare: 1000, rowPitch: pitch, total: 4 })).toBe(4);
  });
  it('folding costs a 更多能力 row: k shown rows + 1 must fit', () => {
    expect(fitCapabilityRows({ spare: 4 * pitch - 1, rowPitch: pitch, total: 4 })).toBe(2);
    expect(fitCapabilityRows({ spare: 3 * pitch, rowPitch: pitch, total: 4 })).toBe(2);
    expect(fitCapabilityRows({ spare: 2 * pitch, rowPitch: pitch, total: 4 })).toBe(1);
  });
  it('no room (or a bad measurement) folds everything, never below zero', () => {
    expect(fitCapabilityRows({ spare: 10, rowPitch: pitch, total: 4 })).toBe(0);
    expect(fitCapabilityRows({ spare: -300, rowPitch: pitch, total: 4 })).toBe(0);
    expect(fitCapabilityRows({ spare: NaN, rowPitch: pitch, total: 4 })).toBe(0);
    expect(fitCapabilityRows({ spare: 500, rowPitch: 0, total: 4 })).toBe(0);
    expect(fitCapabilityRows({ spare: 500, rowPitch: pitch, total: 0 })).toBe(0);
  });
  it('split keeps priority order: 团队 > 自动化 > 待办 > 联系人', () => {
    const keys = sidebarNavEntries(all).map((e) => e.key);
    expect(splitCapabilities(keys, 2)).toEqual({ shown: ['teams', 'automations'], folded: ['todos', 'people'] });
    expect(splitCapabilities(keys, 9)).toEqual({ shown: keys, folded: [] });
    expect(splitCapabilities(keys, -1)).toEqual({ shown: [], folded: keys });
  });
});

describe('Sidebar wiring (B-641, B-676, B-713)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the header renders from the top model; the desktop nav column is gone', () => {
    expect(src).not.toContain('className="sb-products"');
    expect(src).toContain("const top = sidebarTopModel({ isDesktop, projectsReady: projectsSnap.status === 'ready', teamsVisible: happyBotEntryVisible });");
    expect(src).not.toContain('sb-more-btn');
    expect(src).toContain("{top.header.includes('create-menu') && (");
    expect(src).toContain('<SidebarActionRows');
    expect(src).toContain('<SidebarChipRow');
    expect(src).toContain('listRef={listRef}');
    expect(src).toContain("<SidebarFooter onSettings={() => navigate('/settings')} onHelp={() => navigate('/help')}");
  });

  it('新建会话 creates a chat directly, 新建项目 names a project, 新建团队 opens the create dialog', () => {
    expect(src).toContain('onNewChat={() => void createChatOrConfigure(navigate, configureNew, { location })}');
    expect(src).toContain('onNewProject={() => void createNamedProject()}');
    expect(src).toContain('const newTeam = () => navigate(NEW_TEAM_PATH);');
    expect(src).toContain('onNewTeam={newTeam}');
    expect(src).toContain('const createItems: MenuItemDef[] = orderCreateMenu([');
  });

  it('every entry goes through the shared list (no hard-wired nav buttons)', () => {
    expect(src).not.toContain("onClick={() => navigate('/todos')}");
    expect(src).not.toContain("onClick={() => navigate('/teams')}");
  });
});
