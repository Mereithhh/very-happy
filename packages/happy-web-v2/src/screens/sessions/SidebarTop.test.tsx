// @vitest-environment happy-dom
/**
 * B-713/B-896/B-926 (spec 2026-10-sidebar-header): 新建会话 ▾ (+ 新建项目 / 新建团队
 * for a new account), the labelled capability rows, the phone chip row and 帮助
 * in the footer.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/app/prefetchSessionDetail', () => ({ prefetchSessionDetail: () => {} }));
vi.mock('@/screens/notifications/NotificationBell', () => ({ NotificationBell: () => <span data-bell /> }));
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), QuickThemeToggle: () => <span data-theme-toggle /> }));

const { SidebarActionRows, SidebarChipRow, SidebarFooter, capabilityMenuItems } = await import('./SidebarTop');
const { moreMenuEntries, sidebarNavEntries, sidebarTopModel } = await import('./sidebarNavEntries');

const names = { issues: 'Issues', board: 'Running', projects: 'Projects', teams: 'Teams', automations: 'Automations', todos: 'Todos', people: 'People', feedback: 'Send feedback' };
const entries = sidebarNavEntries({ teamsVisible: true, automationsVisible: true, automationAttention: 2, incomingPeople: 1 });
const desktop = sidebarTopModel({ isDesktop: true, projectsReady: true, teamsVisible: true });
const phone = sidebarTopModel({ isDesktop: false, projectsReady: true, teamsVisible: true });

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(node: React.ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

const desktopNew = sidebarTopModel({ isDesktop: true, projectsReady: true, teamsVisible: true, projectCount: 0, teamCount: 0 });

function desktopRows(opts: { actions?: readonly ('new-session' | 'new-project' | 'new-team')[]; activePath?: string; capabilities?: typeof entries; pinned?: string[] | null; onPinnedChange?: (keys: string[] | null) => void } & Partial<Record<'onNewChat' | 'onNewProject' | 'onNewTeam' | 'onNavigate', (...args: never[]) => void>> = {}) {
  return (
    <SidebarActionRows
      actions={opts.actions ?? desktopNew.actions}
      creatingChat={false}
      createItems={[]}
      capabilities={opts.capabilities ?? entries}
      capabilityNames={names}
      activePath={opts.activePath ?? '/'}
      pinnedEntries={opts.pinned ?? null}
      onPinnedEntriesChange={opts.onPinnedChange ?? (() => {})}
      onNewChat={opts.onNewChat ?? (() => {})}
      onNewProject={opts.onNewProject ?? (() => {})}
      onNewTeam={opts.onNewTeam ?? (() => {})}
      onNavigate={(opts.onNavigate as (path: string) => void) ?? (() => {})}
    />
  );
}

const cells = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.sb-cap-row')];
const rowKeys = (el: HTMLElement) => cells(el).map((b) => b.dataset.cap ?? 'more');

it('a new account: 新建会话 ▾ / 新建项目 / 新建团队 without opening a menu; 新建团队 starts the create flow', async () => {
  const onNewTeam = vi.fn();
  const onNewChat = vi.fn();
  const el = await render(desktopRows({ onNewTeam, onNewChat }));
  expect(el.querySelector('.sb-new-main')?.textContent).toBe('sidebar.newSession');
  expect(el.querySelector('.sb-new-more')?.getAttribute('aria-label')).toBe('sidebar.newMenu');
  expect(el.querySelector('[data-action="new-project"]')?.textContent).toBe('sidebar.newProject');
  const team = el.querySelector<HTMLButtonElement>('[data-action="new-team"]')!;
  expect(team.textContent).toBe('sidebar.newTeam');
  await act(async () => team.click());
  expect(onNewTeam).toHaveBeenCalledTimes(1);
  await act(async () => el.querySelector<HTMLButtonElement>('.sb-new-main')!.click());
  expect(onNewChat).toHaveBeenCalledTimes(1);
});

it('an account with a project and a team: only 新建会话 ▾ above the entry rows', async () => {
  const el = await render(desktopRows({ actions: desktop.actions }));
  expect(desktop.actions).toEqual(['new-session']);
  expect(el.querySelector('[data-action]')).toBeNull();
  expect(el.querySelector('.sb-cap-nav')).not.toBeNull();
});

it('B-926: every pinned entry is a labelled row — its name is visible text, the count a badge at the row end', async () => {
  const onNavigate = vi.fn();
  const el = await render(desktopRows({ onNavigate }));
  expect(rowKeys(el)).toEqual(['teams', 'automations', 'todos', 'people', 'more']);
  expect(el.querySelector('.sb-cap-nav')?.getAttribute('role')).toBe('toolbar');
  expect(el.querySelector('.sb-cap-nav')?.getAttribute('aria-orientation')).toBe('vertical');
  const auto = el.querySelector<HTMLButtonElement>('[data-cap="automations"]')!;
  // the name is on screen, not only in the tooltip
  expect(auto.querySelector('.sb-cap-name')?.textContent).toBe('Automations');
  expect(auto.getAttribute('aria-label')).toBe('Automations · 2');
  expect(auto.getAttribute('title')).toBe('Automations');
  expect(auto.querySelector('.sb-nav-attn')?.textContent).toBe('2');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-cap="todos"]')!.click());
  expect(onNavigate).toHaveBeenCalledWith('/todos');
  // 反馈 is folded by default
  expect(el.querySelector('[data-cap="feedback"]')).toBeNull();
  const more = el.querySelector<HTMLButtonElement>('.sb-cap-more')!;
  expect(more.querySelector('.sb-cap-name')?.textContent).toBe('sidebar.moreEntries');
});

it('4 rows + 更多 with Issues on (自动化 · 联系人 · 反馈 folded, their count on 更多)', async () => {
  const on = sidebarNavEntries({ projectsVisible: true, issuesVisible: true, teamsVisible: true, automationsVisible: true, automationAttention: 3, incomingPeople: 1 });
  const el = await render(desktopRows({ capabilities: on }));
  expect(rowKeys(el)).toEqual(['issues', 'board', 'projects', 'teams', 'more']);
  const more = el.querySelector<HTMLButtonElement>('.sb-cap-more')!;
  expect(more.getAttribute('aria-label')).toBe('sidebar.moreEntries · 4');
  expect(more.querySelector('.sb-nav-attn')?.textContent).toBe('4');
});

it('the user\'s pinned rows replace the default; 更多 → 调整入口 lists every entry as a checkbox that pins / unpins', async () => {
  const onPinnedChange = vi.fn();
  const el = await render(desktopRows({ pinned: ['people', 'feedback'], onPinnedChange }));
  expect(rowKeys(el)).toEqual(['people', 'feedback', 'more']);
  const more = el.querySelector<HTMLButtonElement>('.sb-cap-more')!;
  await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(menuItems.map((m) => m.textContent?.trim())).toEqual(['Teams', 'Automations · 2', 'Todos', 'sidebar.editEntries']);
  await act(async () => { menuItems.at(-1)!.click(); });
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
  const boxes = [...el.querySelectorAll<HTMLInputElement>('.sb-cap-edit input[type="checkbox"]')];
  expect(boxes.map((b) => [b.dataset.cap, b.checked])).toEqual([['teams', false], ['automations', false], ['todos', false], ['people', true], ['feedback', true]]);
  expect(el.querySelector('.sb-cap-edit')?.getAttribute('aria-label')).toBe('sidebar.pinnedEntries');
  await act(async () => boxes[0].click());
  expect(onPinnedChange).toHaveBeenLastCalledWith(['people', 'feedback', 'teams']);
  await act(async () => el.querySelector<HTMLButtonElement>('.sb-cap-edit-btn:not(.sb-cap-edit-done)')!.click());
  expect(onPinnedChange).toHaveBeenLastCalledWith(null);
  // Esc (or 完成) leaves the editor back to the rows
  await act(async () => { boxes[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(el.querySelector('.sb-cap-edit')).toBeNull();
  expect(rowKeys(el)).toEqual(['people', 'feedback', 'more']);
});

it('one Tab stop: the current page holds it and carries aria-current; ↑/↓/Home/End move focus, 更多 is the last stop, Enter opens', async () => {
  const onNavigate = vi.fn();
  const el = await render(desktopRows({ activePath: '/automations/run/1', onNavigate }));
  const tabbable = () => cells(el).filter((b) => b.tabIndex === 0).map((b) => b.dataset.cap ?? 'more');
  expect(tabbable()).toEqual(['automations']);
  expect(cells(el).filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.dataset.cap)).toEqual(['automations']);
  const nav = el.querySelector<HTMLElement>('.sb-cap-nav')!;
  const press = (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  const focused = () => (document.activeElement as HTMLElement).dataset.cap ?? 'more';
  await act(async () => cells(el)[1].focus());
  await press('ArrowDown');
  expect(focused()).toBe('todos');
  expect(tabbable()).toEqual(['todos']);
  await press('End');
  expect(focused()).toBe('more');
  await press('Home');
  expect(focused()).toBe('teams');
  await press('ArrowUp');
  expect(focused()).toBe('more');
  await press('ArrowLeft');
  expect(focused()).toBe('people');
  await press('ArrowRight');
  expect(focused()).toBe('more');
  await press('Home');
  expect(nav.contains(document.activeElement)).toBe(true);
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(onNavigate).toHaveBeenCalledWith('/teams');
});

it('no current entry: the first row is the Tab stop; a folded current page puts it on 更多', async () => {
  const el = await render(desktopRows({ activePath: '/session/abc' }));
  expect(cells(el).map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  expect(el.querySelector('[aria-current]')).toBeNull();
  await act(async () => root!.render(desktopRows({ activePath: '/settings/feedback' })));
  expect(cells(el).map((b) => b.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
  expect(el.querySelector('.sb-cap-more')?.classList.contains('is-current')).toBe(true);
});

it('the phone 更多 menu lists entries with counts and routes', () => {
  const onNavigate = vi.fn();
  const items = capabilityMenuItems(entries.slice(1).filter((e) => !e.foldedByDefault), names, onNavigate);
  expect(items.map((i) => i.label)).toEqual(['Automations · 2', 'Todos', 'People · 1']);
  items[0].onSelect?.();
  expect(onNavigate).toHaveBeenCalledWith('/automations');
});

it('phone: no action rows; chips 项目 · 团队 open their lists (B-756), 更多 holds the rest with its attention total', async () => {
  const onNavigate = vi.fn();
  const phoneEntries = sidebarNavEntries({ projectsVisible: true, teamsVisible: true, automationsVisible: true, automationAttention: 2, incomingPeople: 1 });
  const el = await render(
    <>
      <SidebarActionRows actions={phone.actions} creatingChat={false} createItems={[]} capabilities={phoneEntries} capabilityNames={names} activePath="/" pinnedEntries={null} onPinnedEntriesChange={() => {}} onNewChat={() => {}} onNewProject={() => {}} onNewTeam={() => {}} onNavigate={() => {}} />
      <SidebarChipRow chips={phone.chips} capabilities={phoneEntries} capabilityNames={names} onNavigate={onNavigate} />
    </>,
  );
  expect(el.querySelector('.sb-actions')).toBeNull();
  const chips = [...el.querySelectorAll('.sb-chips > button')];
  expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['Projects', 'Teams', 'sidebar.moreCapabilities · 3']);
  await act(async () => (chips[0] as HTMLButtonElement).click());
  await act(async () => (chips[1] as HTMLButtonElement).click());
  expect(onNavigate.mock.calls).toEqual([['/projects'], ['/teams']]);
  // 更多 never repeats a chip
  // B-836: 发送反馈 is reachable from the phone's 更多 (desktop: 帮助 footer + Settings)
  expect(moreMenuEntries(phoneEntries, phone.chips).map((e) => e.key)).toEqual(['automations', 'todos', 'people', 'feedback']);
  expect(capabilityMenuItems(moreMenuEntries(phoneEntries, phone.chips), names, onNavigate).at(-1)?.label).toBe('Send feedback');
});

it('帮助 sits in the footer next to 设置', async () => {
  const onHelp = vi.fn();
  const el = await render(<SidebarFooter onSettings={() => {}} onHelp={onHelp} onToggleNotes={() => {}} />);
  const help = el.querySelector<HTMLButtonElement>('.sb-footer .sb-footer-help')!;
  expect(help.textContent?.trim()).toBe('sidebar.help');
  expect(help.previousElementSibling?.textContent?.trim()).toBe('tabs.settings');
  await act(async () => help.click());
  expect(onHelp).toHaveBeenCalledTimes(1);
});
