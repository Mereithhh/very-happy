// @vitest-environment happy-dom
/**
 * B-713 (spec 2026-10-sidebar-header): the sidebar's three create rows, the
 * capability rows that fold into 「更多能力」 by available height, the phone
 * chip row and 帮助 in the footer.
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/app/prefetchSessionDetail', () => ({ prefetchSessionDetail: () => {} }));
vi.mock('@/screens/notifications/NotificationBell', () => ({ NotificationBell: () => <span data-bell /> }));
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), QuickThemeToggle: () => <span data-theme-toggle /> }));

const { SidebarActionRows, SidebarChipRow, SidebarFooter, capabilityMenuItems } = await import('./SidebarTop');
const { moreMenuEntries, sidebarNavEntries, sidebarTopModel } = await import('./sidebarNavEntries');

const names = { projects: 'Projects', teams: 'Teams', automations: 'Automations', todos: 'Todos', people: 'People' };
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

/** A list element whose height the fit reads; happy-dom has no layout, so rows measure 0 → the 34px fallback pitch. */
function listWithHeight(height: number) {
  const list = document.createElement('div');
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: height });
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
  ref.current = list;
  return ref;
}

function desktopRows(listHeight: number, handlers: Partial<Record<'onNewChat' | 'onNewProject' | 'onNewTeam' | 'onNavigate', () => void>> = {}) {
  return (
    <SidebarActionRows
      actions={desktop.actions}
      creatingChat={false}
      createItems={[]}
      capabilities={entries}
      capabilityNames={names}
      listRef={listWithHeight(listHeight)}
      onNewChat={handlers.onNewChat ?? (() => {})}
      onNewProject={handlers.onNewProject ?? (() => {})}
      onNewTeam={handlers.onNewTeam ?? (() => {})}
      onNavigate={handlers.onNavigate ?? (() => {})}
    />
  );
}

const minList = 8 * 34;

it('desktop shows 新建会话 ▾ / 新建项目 / 新建团队 without opening a menu; 新建团队 starts the create flow', async () => {
  const onNewTeam = vi.fn();
  const onNewChat = vi.fn();
  const el = await render(desktopRows(minList + 4 * 34, { onNewTeam, onNewChat }));
  expect(el.querySelector('.sb-new-main')?.textContent).toBe('sidebar.newSession');
  expect(el.querySelector('.sb-new-more')?.getAttribute('aria-label')).toBe('sidebar.newMenu');
  expect(el.querySelector('[data-action="new-project"]')?.textContent).toBe('sidebar.newProject');
  const team = el.querySelector<HTMLButtonElement>('[data-action="new-team"]')!;
  expect(team.textContent).toBe('sidebar.newTeam');
  await act(async () => team.click());
  expect(onNewTeam).toHaveBeenCalledTimes(1);
  await act(async () => el.querySelector<HTMLButtonElement>('.sb-new-main')!.click());
  expect(onNewChat).toHaveBeenCalledTimes(1);
  // every row is a real, enabled button without a negative tabindex → in the Tab order (checked live in Chromium too)
  for (const b of el.querySelectorAll('button')) {
    expect(b.getAttribute('tabindex')).toBeNull();
    expect(b.disabled).toBe(false);
  }
});

it('tall sidebar: all four capability rows, in priority order, and no 更多能力 row', async () => {
  const onNavigate = vi.fn();
  const el = await render(desktopRows(minList + 4 * 34, { onNavigate }));
  expect([...el.querySelectorAll('[data-cap]')].map((b) => b.getAttribute('data-cap'))).toEqual(['teams', 'automations', 'todos', 'people']);
  expect(el.querySelector('.sb-caps-more')).toBeNull();
  // counts stay visible on the row itself
  expect(el.querySelector('[data-cap="automations"]')?.getAttribute('aria-label')).toBe('Automations · 2');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-cap="todos"]')!.click());
  expect(onNavigate).toHaveBeenCalledWith('/todos');
});

it('medium sidebar: the first two rows stay, the rest fold into 更多能力 with their count', async () => {
  const el = await render(desktopRows(minList + 3 * 34));
  expect([...el.querySelectorAll('[data-cap]')].map((b) => b.getAttribute('data-cap'))).toEqual(['teams', 'automations']);
  expect(el.querySelector('.sb-caps-more')?.getAttribute('aria-label')).toBe('sidebar.moreCapabilities · 1');
});

it('no spare height: everything folds into 更多能力 — the list keeps its 8 rows', async () => {
  const el = await render(desktopRows(minList));
  expect(el.querySelectorAll('[data-cap]:not(.sb-caps-more)').length).toBe(0);
  expect(el.querySelector('.sb-caps-more')?.getAttribute('aria-label')).toBe('sidebar.moreCapabilities · 3');
});

it('the fold menu lists the folded entries with counts and routes', () => {
  const onNavigate = vi.fn();
  const items = capabilityMenuItems(entries.slice(1), names, onNavigate);
  expect(items.map((i) => i.label)).toEqual(['Automations · 2', 'Todos', 'People · 1']);
  expect(items.map((i) => i.key)).not.toContain('help');
  items[0].onSelect?.();
  expect(onNavigate).toHaveBeenCalledWith('/automations');
});

it('phone: no action rows; chips 项目 · 团队 open their lists (B-756), 更多 holds the rest with its attention total', async () => {
  const onNavigate = vi.fn();
  const phoneEntries = sidebarNavEntries({ projectsVisible: true, teamsVisible: true, automationsVisible: true, automationAttention: 2, incomingPeople: 1 });
  const el = await render(
    <>
      <SidebarActionRows actions={phone.actions} creatingChat={false} createItems={[]} capabilities={phoneEntries} capabilityNames={names} listRef={listWithHeight(900)} onNewChat={() => {}} onNewProject={() => {}} onNewTeam={() => {}} onNavigate={() => {}} />
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
  expect(moreMenuEntries(phoneEntries, phone.chips).map((e) => e.key)).toEqual(['automations', 'todos', 'people']);
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
