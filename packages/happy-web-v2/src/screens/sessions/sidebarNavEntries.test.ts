import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEW_TEAM_PATH, isEntryCurrent, navAttentionTotal, navMenuLabel, orderCreateMenu, sidebarNavEntries, sidebarTopModel, splitNavEntries, stripFocusTarget, togglePinnedEntry } from './sidebarNavEntries';

const all = { teamsVisible: true, automationsVisible: true, automationAttention: 0, incomingPeople: 0 };

describe('sidebarNavEntries (B-641)', () => {
  it('lists every capability entry in priority order with its route — 帮助 is not one (B-713: footer)', () => {
    expect(sidebarNavEntries(all).map((e) => [e.key, e.path])).toEqual([
      ['teams', '/teams'],
      ['automations', '/automations'],
      ['todos', '/todos'],
      ['people', '/people'],
      ['feedback', '/settings/feedback'],
    ]);
    // B-836/B-926: 反馈 is never a default row — it sits in 更多 unless pinned
    expect(sidebarNavEntries(all).filter((e) => e.foldedByDefault).map((e) => e.key)).toEqual(['feedback']);
  });

  it('B-756: 项目 leads the entries once the projects API answered, and opens the /projects list', () => {
    expect(sidebarNavEntries({ ...all, projectsVisible: true }).map((e) => [e.key, e.path])[0]).toEqual(['projects', '/projects']);
    expect(sidebarNavEntries({ ...all, projectsVisible: false }).map((e) => e.key)).not.toContain('projects');
  });

  it('keeps the existing visibility gates for teams and automations', () => {
    const keys = sidebarNavEntries({ ...all, teamsVisible: false, automationsVisible: false }).map((e) => e.key);
    expect(keys).toEqual(['todos', 'people', 'feedback']);
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

describe('B-873 Issues entries (spec 2026-11-issues §10 / Q11)', () => {
  it('switch off (or not answered yet): exactly the entries and chips from before', () => {
    const before = sidebarNavEntries(all);
    expect(sidebarNavEntries({ ...all, issuesVisible: false, issueAttention: 5 })).toEqual(before);
    expect(before.map((e) => e.key)).toEqual(['teams', 'automations', 'todos', 'people', 'feedback']);
    expect(sidebarTopModel({ isDesktop: false, projectsReady: true, teamsVisible: true, issuesVisible: false })).toEqual(sidebarTopModel({ isDesktop: false, projectsReady: true, teamsVisible: true }));
  });
  it('switch on: Issues first, 运行中 (/board) right after it, 待办 gone (/todos redirects)', () => {
    const entries = sidebarNavEntries({ ...all, projectsVisible: true, issuesVisible: true, issueAttention: 2 });
    expect(entries.map((e) => [e.key, e.path]).slice(0, 3)).toEqual([['issues', '/issues'], ['board', '/board'], ['projects', '/projects']]);
    expect(entries.map((e) => e.key)).not.toContain('todos');
    expect(entries[0]).toMatchObject({ attention: 2, tone: 'warn' });
    expect(sidebarTopModel({ isDesktop: false, projectsReady: true, teamsVisible: true, issuesVisible: true }).chips).toEqual(['issues', 'projects', 'teams', 'more']);
  });
});

describe('sidebar top model (B-676, B-713, B-896)', () => {
  const base = { projectsReady: true, teamsVisible: true };
  it('desktop: no ⋯ — header 🔍 · collapse; an account with projects and teams keeps only 新建会话 ▾', () => {
    expect(sidebarTopModel({ isDesktop: true, ...base, projectCount: 3, teamCount: 1 })).toEqual({ header: ['search', 'collapse'], actions: ['new-session'], chips: [] });
  });
  it('B-896: a new account still sees labelled 新建项目 / 新建团队 rows, each gone once it has one', () => {
    expect(sidebarTopModel({ isDesktop: true, ...base, projectCount: 0, teamCount: 0 }).actions).toEqual(['new-session', 'new-project', 'new-team']);
    expect(sidebarTopModel({ isDesktop: true, ...base, projectCount: 1, teamCount: 0 }).actions).toEqual(['new-session', 'new-team']);
    expect(sidebarTopModel({ isDesktop: true, ...base, projectCount: 0, teamCount: 2 }).actions).toEqual(['new-session', 'new-project']);
  });
  it('B-896: an unknown count (not loaded / failed) shows no row, so existing accounts never see one flash in', () => {
    expect(sidebarTopModel({ isDesktop: true, ...base }).actions).toEqual(['new-session']);
    expect(sidebarTopModel({ isDesktop: true, ...base, projectCount: null, teamCount: null }).actions).toEqual(['new-session']);
  });
  it('desktop drops 新建项目 without the projects API and 新建团队 when Teams is hidden', () => {
    expect(sidebarTopModel({ isDesktop: true, projectsReady: false, teamsVisible: true, projectCount: 0, teamCount: 0 }).actions).toEqual(['new-session', 'new-team']);
    expect(sidebarTopModel({ isDesktop: true, projectsReady: true, teamsVisible: false, projectCount: 0, teamCount: 0 }).actions).toEqual(['new-session', 'new-project']);
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

describe('capability rows keyboard (B-896, B-926)', () => {
  it('↓/↑ and →/← wrap, Home/End jump, other keys are not the group\'s', () => {
    expect(stripFocusTarget('ArrowDown', 0, 5)).toBe(1);
    expect(stripFocusTarget('ArrowDown', 4, 5)).toBe(0);
    expect(stripFocusTarget('ArrowUp', 0, 5)).toBe(4);
    expect(stripFocusTarget('ArrowUp', 2, 5)).toBe(1);
    expect(stripFocusTarget('ArrowRight', 0, 6)).toBe(1);
    expect(stripFocusTarget('ArrowRight', 5, 6)).toBe(0);
    expect(stripFocusTarget('ArrowLeft', 0, 6)).toBe(5);
    expect(stripFocusTarget('ArrowLeft', 3, 6)).toBe(2);
    expect(stripFocusTarget('Home', 4, 6)).toBe(0);
    expect(stripFocusTarget('End', 0, 5)).toBe(4);
    expect(stripFocusTarget('Enter', 2, 6)).toBeNull();
    expect(stripFocusTarget('Tab', 2, 6)).toBeNull();
    expect(stripFocusTarget('ArrowRight', 0, 0)).toBeNull();
  });
  it('an entry stays current on its sub-pages, not on a sibling sharing a prefix', () => {
    expect(isEntryCurrent('/issues', '/issues')).toBe(true);
    expect(isEntryCurrent('/issues', '/issues/VH-3')).toBe(true);
    expect(isEntryCurrent('/projects', '/projectsx')).toBe(false);
    expect(isEntryCurrent('/board', '/')).toBe(false);
  });
});

describe('pinned rows vs 更多 (B-926)', () => {
  const on = sidebarNavEntries({ ...all, projectsVisible: true, issuesVisible: true });
  const off = sidebarNavEntries({ ...all, projectsVisible: true });
  const keys = (xs: readonly { key: string }[]) => xs.map((e) => e.key);
  it('default: the first four rows stay, the rest (and 反馈) fold into 更多, both in priority order', () => {
    expect(keys(splitNavEntries(on, null).pinned)).toEqual(['issues', 'board', 'projects', 'teams']);
    expect(keys(splitNavEntries(on, null).more)).toEqual(['automations', 'people', 'feedback']);
    expect(keys(splitNavEntries(off, null).pinned)).toEqual(['projects', 'teams', 'automations', 'todos']);
    expect(keys(splitNavEntries(off, null).more)).toEqual(['people', 'feedback']);
  });
  it('a user choice keeps priority order and ignores unknown / currently hidden keys', () => {
    const split = splitNavEntries(off, ['people', 'issues', 'nope', 'projects']);
    expect(keys(split.pinned)).toEqual(['projects', 'people']);
    expect(keys(split.more)).toEqual(['teams', 'automations', 'todos', 'feedback']);
    expect(keys(splitNavEntries(off, []).pinned)).toEqual([]);
  });
  it('toggling materialises the default first, then adds / removes one key; hidden pins survive', () => {
    expect(togglePinnedEntry(on, null, 'teams')).toEqual(['issues', 'board', 'projects']);
    expect(togglePinnedEntry(on, null, 'feedback')).toEqual(['issues', 'board', 'projects', 'teams', 'feedback']);
    // Issues off right now: its pin is kept for when it comes back
    expect(togglePinnedEntry(off, ['issues', 'projects'], 'people')).toEqual(['issues', 'projects', 'people']);
  });
});

describe('Sidebar wiring (B-641, B-676, B-713)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the header renders from the top model; the desktop nav column is gone', () => {
    expect(src).not.toContain('className="sb-products"');
    expect(src).toContain("const top = sidebarTopModel({");
    expect(src).toContain("teamCount: isTeamNavigationLoaded(teams) ? teams.length : null,");
    expect(src).not.toContain('sb-more-btn');
    expect(src).toContain("{top.header.includes('create-menu') && (");
    expect(src).toContain('<SidebarActionRows');
    expect(src).toContain('<SidebarChipRow');
    expect(src).toContain('activePath={location.pathname}');
    expect(src).toContain('createItems={desktopCreateItems}');
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
