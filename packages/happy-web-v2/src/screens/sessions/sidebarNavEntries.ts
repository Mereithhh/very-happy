/**
 * B-641: the sidebar's secondary "Workspace" entries (团队 / 自动化 / 待办 /
 * 联系人 / 帮助). Since B-676 they live in the header's ⋯ menu on every
 * device (desktop used to keep a five-row nav column; spec
 * 2026-10-sidebar-header), so the list gets the height. Visibility gates and
 * attention counts are computed here once.
 */
export type SidebarNavKey = 'teams' | 'automations' | 'todos' | 'people' | 'help';

export interface SidebarNavEntry {
  key: SidebarNavKey;
  path: string;
  /** count that needs the user (automation decisions / incoming contact requests); 0 = none */
  attention: number;
}

export function sidebarNavEntries(input: {
  teamsVisible: boolean;
  automationsVisible: boolean;
  automationAttention: number;
  incomingPeople: number;
}): SidebarNavEntry[] {
  const entries: SidebarNavEntry[] = [];
  if (input.teamsVisible) entries.push({ key: 'teams', path: '/teams', attention: 0 });
  if (input.automationsVisible) entries.push({ key: 'automations', path: '/automations', attention: Math.max(0, input.automationAttention) });
  entries.push({ key: 'todos', path: '/todos', attention: 0 });
  entries.push({ key: 'people', path: '/people', attention: Math.max(0, input.incomingPeople) });
  entries.push({ key: 'help', path: '/help', attention: 0 });
  return entries;
}

/** Total shown on the collapsed ⋯ trigger, so a folded entry never hides a pending decision. */
export function navAttentionTotal(entries: readonly SidebarNavEntry[]): number {
  return entries.reduce((sum, e) => sum + e.attention, 0);
}

/** Menu label: the entry name plus its count, e.g. 「自动化 · 2」. */
export function navMenuLabel(name: string, attention: number): string {
  return attention > 0 ? `${name} · ${attention}` : name;
}

/**
 * B-676: what the sidebar top renders, as data (spec 2026-10-sidebar-header).
 * Header row: search and ⋯ everywhere; collapse only in the two-pane shell;
 * the phone keeps B-641's ＋ create menu instead of action rows. Desktop gets
 * two labelled action rows: 新建会话 (main click = new chat, ▾ = every create
 * type) and 新建项目 (only once the projects API answered).
 */
export type SidebarHeaderControl = 'search' | 'create-menu' | 'more' | 'collapse';
export type SidebarActionRow = 'new-session' | 'new-project';

export function sidebarTopModel(input: { isDesktop: boolean; projectsReady: boolean }): { header: SidebarHeaderControl[]; actions: SidebarActionRow[] } {
  if (!input.isDesktop) return { header: ['search', 'create-menu', 'more'], actions: [] };
  return { header: ['search', 'more', 'collapse'], actions: input.projectsReady ? ['new-session', 'new-project'] : ['new-session'] };
}

/** Create menu order: 新会话 first, 新项目 second, then the rest as given. */
export function orderCreateMenu<T extends { key: string }>(items: readonly T[]): T[] {
  const rank = (k: string) => (k === 'chat' ? 0 : k === 'project' ? 1 : 2);
  return items.map((item, i) => ({ item, i })).sort((a, b) => rank(a.item.key) - rank(b.item.key) || a.i - b.i).map((x) => x.item);
}
