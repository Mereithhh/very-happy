// @vitest-environment happy-dom
/**
 * B-713/B-896 (spec 2026-10-sidebar-header): 新建会话 ▾ (+ 新建项目 / 新建团队
 * for a new account), the capability icon strip, the phone chip row and 帮助
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

function desktopRows(opts: { actions?: readonly ('new-session' | 'new-project' | 'new-team')[]; activePath?: string; capabilities?: typeof entries } & Partial<Record<'onNewChat' | 'onNewProject' | 'onNewTeam' | 'onNavigate', (...args: never[]) => void>> = {}) {
  return (
    <SidebarActionRows
      actions={opts.actions ?? desktopNew.actions}
      creatingChat={false}
      createItems={[]}
      capabilities={opts.capabilities ?? entries}
      capabilityNames={names}
      activePath={opts.activePath ?? '/'}
      onNewChat={opts.onNewChat ?? (() => {})}
      onNewProject={opts.onNewProject ?? (() => {})}
      onNewTeam={opts.onNewTeam ?? (() => {})}
      onNavigate={(opts.onNavigate as (path: string) => void) ?? (() => {})}
    />
  );
}

const cells = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.sb-cap-cell')];

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

it('an account with a project and a team: only 新建会话 ▾ above the strip', async () => {
  const el = await render(desktopRows({ actions: desktop.actions }));
  expect(desktop.actions).toEqual(['new-session']);
  expect(el.querySelector('[data-action]')).toBeNull();
  expect(el.querySelector('.sb-cap-strip')).not.toBeNull();
});

it('the strip: every desktop entry is one icon cell with its name + count as tooltip and label', async () => {
  const onNavigate = vi.fn();
  const el = await render(desktopRows({ onNavigate }));
  expect(cells(el).map((b) => b.dataset.cap)).toEqual(['teams', 'automations', 'todos', 'people']);
  expect(el.querySelector('.sb-cap-strip')?.getAttribute('role')).toBe('toolbar');
  const auto = el.querySelector<HTMLButtonElement>('[data-cap="automations"]')!;
  expect(auto.getAttribute('aria-label')).toBe('Automations · 2');
  expect(auto.getAttribute('title')).toBe('Automations · 2');
  expect(auto.querySelector('.sb-nav-attn')?.textContent).toBe('2');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-cap="todos"]')!.click());
  expect(onNavigate).toHaveBeenCalledWith('/todos');
  // B-836: 反馈 never takes a desktop cell
  expect(el.querySelector('[data-cap="feedback"]')).toBeNull();
});

it('6 cells with Issues on, 5 with it off', async () => {
  const on = sidebarNavEntries({ projectsVisible: true, issuesVisible: true, teamsVisible: true, automationsVisible: true, automationAttention: 0, incomingPeople: 0 });
  const el = await render(desktopRows({ capabilities: on }));
  expect(cells(el).map((b) => b.dataset.cap)).toEqual(['issues', 'board', 'projects', 'teams', 'automations', 'people']);
  await act(async () => root!.render(desktopRows({ capabilities: sidebarNavEntries({ projectsVisible: true, teamsVisible: true, automationsVisible: true, automationAttention: 0, incomingPeople: 0 }) })));
  expect(cells(el).length).toBe(5);
});

it('one Tab stop: the current page holds it and carries aria-current; ←/→/Home/End move focus, Enter opens', async () => {
  const onNavigate = vi.fn();
  const el = await render(desktopRows({ activePath: '/automations/run/1', onNavigate }));
  const tabbable = () => cells(el).filter((b) => b.tabIndex === 0).map((b) => b.dataset.cap);
  expect(tabbable()).toEqual(['automations']);
  expect(cells(el).filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.dataset.cap)).toEqual(['automations']);
  const strip = el.querySelector<HTMLElement>('.sb-cap-strip')!;
  const press = (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  await act(async () => cells(el)[1].focus());
  await press('ArrowRight');
  expect((document.activeElement as HTMLElement).dataset.cap).toBe('todos');
  expect(tabbable()).toEqual(['todos']);
  await press('End');
  expect((document.activeElement as HTMLElement).dataset.cap).toBe('people');
  await press('ArrowRight');
  expect((document.activeElement as HTMLElement).dataset.cap).toBe('teams');
  await press('ArrowLeft');
  expect((document.activeElement as HTMLElement).dataset.cap).toBe('people');
  await press('Home');
  expect((document.activeElement as HTMLElement).dataset.cap).toBe('teams');
  expect(strip.contains(document.activeElement)).toBe(true);
  // Enter on a native <button> clicks it
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(onNavigate).toHaveBeenCalledWith('/teams');
});

it('no current entry: the first cell is the Tab stop', async () => {
  const el = await render(desktopRows({ activePath: '/session/abc' }));
  expect(cells(el).map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
  expect(el.querySelector('[aria-current]')).toBeNull();
});

it('the phone 更多 menu lists entries with counts and routes', () => {
  const onNavigate = vi.fn();
  const items = capabilityMenuItems(entries.slice(1).filter((e) => !e.phoneOnly), names, onNavigate);
  expect(items.map((i) => i.label)).toEqual(['Automations · 2', 'Todos', 'People · 1']);
  items[0].onSelect?.();
  expect(onNavigate).toHaveBeenCalledWith('/automations');
});

it('phone: no action rows; chips 项目 · 团队 open their lists (B-756), 更多 holds the rest with its attention total', async () => {
  const onNavigate = vi.fn();
  const phoneEntries = sidebarNavEntries({ projectsVisible: true, teamsVisible: true, automationsVisible: true, automationAttention: 2, incomingPeople: 1 });
  const el = await render(
    <>
      <SidebarActionRows actions={phone.actions} creatingChat={false} createItems={[]} capabilities={phoneEntries} capabilityNames={names} activePath="/" onNewChat={() => {}} onNewProject={() => {}} onNewTeam={() => {}} onNavigate={() => {}} />
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
