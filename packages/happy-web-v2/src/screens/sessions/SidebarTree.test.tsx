// @vitest-environment happy-dom
/**
 * B-762 (spec B-760 §5): the real <Sidebar/> in its three lenses over the
 * prototype's Atlas scene (src/dev/sidebarTreeScene.ts).
 *  - 按项目: a tree — project › team › lead / members, sessions beside the
 *    team, then ONE flat 不在项目中 area (D2); badges on every level; default
 *    folds; ↑/↓/←/→.
 *  - 按标签 / 最近: conversations only, one owner chip each; members only while
 *    they wait for the user (D3); no 「项目」 area (D1) — the 项目 capability
 *    row carries the badge instead.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { sidebarTreeScene, type SceneKind } from '@/dev/sidebarTreeScene';

const h = vi.hoisted(() => ({
  teams: [] as TeamState[],
  projects: { status: 'ready', projects: [] as ProjectView[], members: [] as ProjectMemberView[] },
}));
vi.mock('./useTeamNavigation', () => ({ useTeamNavigation: () => h.teams }));
vi.mock('@/sync/projects', async (orig) => ({
  ...(await orig<typeof import('@/sync/projects')>()),
  useProjects: () => h.projects,
  refreshProjects: () => Promise.resolve(),
}));
vi.mock('@/sync/automationsStore', async (orig) => ({ ...(await orig<typeof import('@/sync/automationsStore')>()), useAutomationsPoll: () => {} }));
// The decorative ASCII field is irrelevant here (its engine needs a real canvas).
vi.mock('@/ui/asciiField/AsciiField', () => ({ AsciiField: () => null }));
vi.mock('@/app/useMediaQuery', async (orig) => ({ ...(await orig<typeof import('@/app/useMediaQuery')>()), useIsDesktop: () => true }));

const { storage } = await import('@/sync/storage');
const { setLanguage } = await import('@/text');
const { ThemeProvider } = await import('@/ui/theme');
const { Sidebar } = await import('./Sidebar');
const { COLLAPSED_GROUPS_STORAGE_KEY } = await import('./sidebarCollapsedGroups');
const pristine = storage.getState();

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  setLanguage('zh-Hans');
  storage.setState(pristine, true);
  localStorage.removeItem(COLLAPSED_GROUPS_STORAGE_KEY);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(kind: SceneKind, lens: 'project' | 'tag' | 'none', path = '/') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const scene = sidebarTreeScene(kind);
  h.teams = scene.teams;
  h.projects = { status: 'ready', projects: scene.projects, members: scene.members };
  const st = storage.getState();
  st.applyLocalSettings({ sidebarView: 'list', sidebarGrouping: lens, sidebarProjectHintDismissed: false, sidebarUnassignedByFolder: false });
  st.applySessions(scene.sessions);
  st.applyReady();
  for (const id of scene.unread) st.markSessionUnread(id);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ThemeProvider><MemoryRouter initialEntries={[path]}><Sidebar /></MemoryRouter></ThemeProvider>));
  return host;
}

const list = (el: HTMLElement) => el.querySelector<HTMLElement>('.sb-list')!;
/** Every tree node as `depth|text` — the shape of the tree on screen. */
function treeShape(el: HTMLElement): string[] {
  return [...list(el).querySelectorAll<HTMLElement>('[data-tree-node]')].map((n) => `${n.dataset.depth}|${(n.querySelector('.sb-tree-project-name, .sb-team-name, .sb-row-title, .sb-team-archived, .sb-team-empty, .sb-tree-empty, .sb-tree-area-toggle, .sb-tree-area-label')?.textContent ?? '').trim()}`);
}

describe('按项目: the project tree', () => {
  it('projects › team › lead / members, sessions beside the team, empty project hint, then 不在项目中', async () => {
    const el = await mount('atlas', 'project', '/teams/t-atlas');
    const shape = treeShape(el);
    expect(shape.slice(0, 9)).toEqual([
      '0|Atlas 支付重构',
      '1|Atlas 研发队',
      '2|拆分网关并分派', // B-773: 「负责人」 is a prefix beside the title box
      '2|前端-1 · 结算页改造',
      '2|后端-1 · 退款接口迁移',
      '2|测试-1 · 回归用例',
      '2|已停用 2 个',
      '1|排查退款回调超时',
      '1|迁移脚本草稿',
    ]);
    expect(shape).toContain('0|移动端试验');
    expect(shape).toContain('1|还没有内容。 新建会话 或 组建团队');
    // 不在项目中: one flat area — the old team at depth 0, loose chats at 0, no folder heads (D2).
    const area = shape.indexOf('-1|不在项目中6');
    expect(area).toBeGreaterThan(0);
    expect(shape.slice(area + 1)).toEqual(['0|临时调研队', '0|Shell 别名整理', '0|正则写法速查', '0|写个周末计划', '0|论文阅读笔记']);
    expect(list(el).querySelector('.sb-section-head--workspace')).toBeNull();
  });

  it('badges on every level roll up 需要你 (waiting + unread); a count when nothing needs you; 项目 capability carries the total (D1)', async () => {
    const el = await mount('atlas', 'project', '/teams/t-atlas');
    const atlas = list(el).querySelector<HTMLElement>('.sb-tree-project')!;
    expect(atlas.querySelector('.sb-tree-badge')!.textContent).toBe('2'); // 后端-1 waiting + 排查退款回调超时 unread
    const team = list(el).querySelector<HTMLElement>('[data-team-id="t-atlas"]')!;
    expect(team.querySelector('.sb-tree-badge')!.textContent).toBe('1'); // 后端-1
    const web = [...list(el).querySelectorAll<HTMLElement>('.sb-tree-project')].find((p) => p.textContent?.includes('官网改版'))!;
    expect(web.querySelector('.sb-tree-badge')).toBeNull();
    expect(web.querySelector('.sb-tree-count')!.textContent).toBe('3');
    expect(list(el).querySelector('[data-team-id="t-web"] .sb-tree-count')!.textContent).toMatch(/^1 /);
    // 项目 capability row: the projects' total (D1); the old team outside every project says so.
    expect(el.querySelector('[data-cap="projects"] .sb-nav-attn')!.textContent).toBe('2');
    expect(list(el).querySelector('[data-team-id="t-scout"] .sb-team-unplaced')).not.toBeNull();
  });

  it('default folds: a team stays closed unless its page or a member is current', async () => {
    const el = await mount('atlas', 'project', '/');
    const shape = treeShape(el);
    expect(shape).toContain('1|Atlas 研发队');
    expect(shape).not.toContain('2|前端-1 · 结算页改造'); // folded: not on its page
    expect(list(el).querySelector('[data-team-id="t-atlas"] [data-tree-toggle]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('a member conversation opens its team (and the lead row reads 负责人 + task)', async () => {
    const el = await mount('atlas', 'project', '/session/be1');
    const shape = treeShape(el);
    expect(shape).toContain('2|后端-1 · 退款接口迁移');
    expect(list(el).querySelector('.sb-lead-tag')!.textContent).toBe('负责人');
  });

  it('B-773 (QA5): the 「负责人」 tag sits beside the title box, never inside its ellipsis box', async () => {
    const el = await mount('crowded', 'project', '/teams/t-atlas');
    const tag = list(el).querySelector<HTMLElement>('.sb-lead-tag')!;
    expect(tag.parentElement!.classList.contains('sb-row-title-line')).toBe(true);
    expect(tag.closest('.sb-row-title')).toBeNull();
    expect(tag.nextElementSibling!.className).toBe('sb-row-title');
    expect(tag.nextElementSibling!.textContent).toBe('Coordinate coding agents via Very Happy teams');
    // Layout (title text ≥ 6em or whole, chips drop or shrink first): CSS pinned in
    // sidebarTeamRowWiring.test.ts, measured in Chromium by tmp/vh-team-B-773/assert-titles.mjs.
  });

  it('keyboard: ↓ moves, → opens a folded team, ← folds it, ← again steps out to the project', async () => {
    const el = await mount('atlas', 'project', '/');
    const items = () => [...list(el).querySelectorAll<HTMLElement>('[data-tree-item]')];
    const key = (k: string) => act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
    items()[0].focus(); // Atlas 支付重构
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toContain('Atlas 研发队');
    await key('ArrowRight');
    expect(treeShape(el)).toContain('2|前端-1 · 结算页改造');
    await key('ArrowLeft');
    expect(treeShape(el)).not.toContain('2|前端-1 · 结算页改造');
    await key('ArrowLeft');
    expect(document.activeElement?.textContent).toContain('Atlas 支付重构');
    await key('ArrowLeft'); // folds the project
    expect(treeShape(el)).not.toContain('1|Atlas 研发队');
  });

  it('only chats, no project yet: the area is 「会话」 with the put-in-a-project hint, flat, nothing folds', async () => {
    const el = await mount('solo', 'project', '/');
    expect(treeShape(el)).toEqual(['-1|会话', '0|Shell 别名整理', '0|正则写法速查', '0|写个周末计划', '0|论文阅读笔记']);
    expect(list(el).querySelector('.sb-tree-hint')!.textContent).toContain('相关的会话放进同一个项目');
    expect(list(el).querySelector('.sb-tree-area-toggle')).toBeNull();
  });

  it('new user: nothing to draw, the empty line only', async () => {
    const el = await mount('fresh', 'project', '/');
    expect(treeShape(el)).toEqual([]);
    expect(list(el).querySelector('.sb-empty')).not.toBeNull();
  });
});

describe('按标签 / 最近: conversation lists', () => {
  const titles = (el: HTMLElement) => [...list(el).querySelectorAll('.sb-row-title')].map((t) => t.textContent);
  const chipOf = (el: HTMLElement, title: string) => [...list(el).querySelectorAll<HTMLElement>('.sb-row')].find((r) => r.querySelector('.sb-row-title')?.textContent === title)?.querySelector('.sb-row-project')?.textContent ?? null;

  it('按标签: no project area (D1), no team rows, tag groups only; one owner chip per row', async () => {
    const el = await mount('atlas', 'tag', '/');
    expect(list(el).querySelector('.sb-tree-project, .sb-team-row, [data-tree-node]')).toBeNull();
    expect(list(el).textContent).not.toContain('Atlas 研发队负责人'); // no team head
    expect(chipOf(el, '排查退款回调超时')).toBe('Atlas 支付重构');
    expect(chipOf(el, '拆分网关并分派')).toBe('Atlas 研发队');
    expect(chipOf(el, '正则写法速查')).toBeNull();
    expect(el.querySelector('[data-cap="projects"] .sb-nav-attn')!.textContent).toBe('2');
  });

  it('D3: members only while they wait for the user; leads always', async () => {
    for (const lens of ['tag', 'none'] as const) {
      const el = await mount('atlas', lens, '/');
      const t = titles(el);
      expect(t).toContain('后端-1 · 退款接口迁移'); // waiting
      expect(t).not.toContain('前端-1 · 结算页改造'); // running, not waiting
      expect(t).not.toContain('测试-1 · 回归用例');
      expect(t).not.toContain('调研-1 · 整理报价');
      expect(t).toContain('拆分网关并分派');
      expect(t).toContain('评估首页需求');
      await act(async () => root!.unmount()); root = null; host!.remove();
    }
  });

  it('review: a long project name never eats the title — the name sits in its own ellipsis span, the chip’s title is the full name', async () => {
    const el = await mount('atlas', 'none', '/');
    const row = [...list(el).querySelectorAll<HTMLElement>('.sb-row')].find((r) => r.querySelector('.sb-row-title')?.textContent === '排查对账任务在月末批量重跑时的超时与重复入账')!;
    const chip = row.querySelector<HTMLElement>('.sb-row-project')!;
    expect(chip.getAttribute('title')).toBe('跨境结算与多币种对账平台迁移');
    expect(chip.querySelector('.sb-row-project-name')!.textContent).toBe('跨境结算与多币种对账平台迁移');
    // Layout (chip ≤ 40%, real ellipsis): CSS pinned in sidebarTeamRowWiring.test.ts, measured in Chromium by tmp/vh-team-B-762/assert-chips.mjs.
    // B-773: title widths are now 6em on lead/member rows and 5em on other rows (no longer 8em). assert-titles.mjs
    // (tmp/vh-team-B-773) supersedes assert-chips for title widths, so an 8em miss there is not a regression.
  });

  it('最近 (formerly 不分组): one flat list, the lens button says 最近', async () => {
    const el = await mount('atlas', 'none', '/');
    expect(list(el).querySelector('.sb-section-head')).toBeNull();
    expect(el.querySelector('.sb-lens-btn')!.textContent).toBe('最近');
    expect(chipOf(el, '后端-1 · 退款接口迁移')).toBe('Atlas 研发队');
  });
});
