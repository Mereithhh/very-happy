import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { navAttentionTotal, navMenuLabel, orderCreateMenu, sidebarNavEntries, sidebarTopModel } from './sidebarNavEntries';

const all = { teamsVisible: true, automationsVisible: true, automationAttention: 0, incomingPeople: 0 };

describe('sidebarNavEntries (B-641)', () => {
  it('lists every secondary entry in the desktop order with its route', () => {
    expect(sidebarNavEntries(all).map((e) => [e.key, e.path])).toEqual([
      ['teams', '/teams'],
      ['automations', '/automations'],
      ['todos', '/todos'],
      ['people', '/people'],
      ['help', '/help'],
    ]);
  });

  it('keeps the existing visibility gates for teams and automations', () => {
    const keys = sidebarNavEntries({ ...all, teamsVisible: false, automationsVisible: false }).map((e) => e.key);
    expect(keys).toEqual(['todos', 'people', 'help']);
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

describe('sidebar top model (B-676)', () => {
  it('desktop: search · ⋯ · collapse in the header, then 新建会话 and 新建项目 rows — no nav column', () => {
    expect(sidebarTopModel({ isDesktop: true, projectsReady: true })).toEqual({ header: ['search', 'more', 'collapse'], actions: ['new-session', 'new-project'] });
  });
  it('desktop without the projects API keeps 新建会话 only', () => {
    expect(sidebarTopModel({ isDesktop: true, projectsReady: false }).actions).toEqual(['new-session']);
  });
  it('phone keeps B-641: search · ＋ · ⋯ and no action rows (list height unchanged)', () => {
    expect(sidebarTopModel({ isDesktop: false, projectsReady: true })).toEqual({ header: ['search', 'create-menu', 'more'], actions: [] });
  });
  it('fewer always-visible controls than before B-676 on desktop (8 → 6 excluding the brand)', () => {
    const m = sidebarTopModel({ isDesktop: true, projectsReady: true });
    // new-session is a split control: main + ▾
    expect(m.header.length + m.actions.length + 1).toBe(6);
  });
  it('create menu: 新会话 first, 新项目 second, the rest in their given order', () => {
    const keys = orderCreateMenu([{ key: 'project' }, { key: 'chat' }, { key: 'advanced' }, { key: 'terminal' }, { key: 'connect-machine' }]).map((i) => i.key);
    expect(keys).toEqual(['chat', 'project', 'advanced', 'terminal', 'connect-machine']);
    expect(orderCreateMenu([{ key: 'chat' }, { key: 'terminal' }]).map((i) => i.key)).toEqual(['chat', 'terminal']);
  });
});

describe('Sidebar wiring (B-641, B-676)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the header renders from the top model; the desktop nav column is gone', () => {
    expect(src).not.toContain('className="sb-products"');
    expect(src).toContain("const top = sidebarTopModel({ isDesktop, projectsReady: projectsSnap.status === 'ready' });");
    expect(src).toContain("{top.header.includes('more') && (");
    expect(src).toContain("{top.header.includes('create-menu') && (");
    expect(src).toContain('items={navEntries.map((e) => ({ key: e.key, label: navMenuLabel(navName[e.key], e.attention)');
    expect(src).toContain('{navAttention > 0 && <span className="sb-more-attn mono"');
  });

  it('新建会话 main click creates a chat directly; ▾ opens the create menu; 新建项目 is its own row', () => {
    expect(src).toContain('className="sb-nav-btn sb-new-main"');
    expect(src).toContain("onClick={() => void createChatOrConfigure(navigate, configureNew, { location })}>");
    expect(src).toContain('contentMinWidth={newRowWidth} items={createItems}');
    expect(src).toContain("{top.actions.includes('new-project') && (");
    expect(src).toContain('onClick={() => void createNamedProject()}>');
    expect(src).toContain('const createItems: MenuItemDef[] = orderCreateMenu([');
  });

  it('every entry goes through the shared list (no hard-wired nav buttons)', () => {
    expect(src).not.toContain("onClick={() => navigate('/todos')}");
    expect(src).not.toContain("onClick={() => navigate('/teams')}");
  });
});
