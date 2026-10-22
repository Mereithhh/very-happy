/**
 * B-641: the sidebar's capability entries (项目 / 团队 / 自动化 / 待办 / 联系人), in
 * priority order. B-713 (spec 2026-10-sidebar-header): desktop shows as many
 * as fit as labelled rows under the create rows and folds the rest into
 * 「更多能力 ▾」; the phone folds them all into the chip row's 「更多 ▾」.
 * 帮助 lives in the sidebar footer. Visibility gates and attention counts are
 * computed here once. B-756: 项目 (the /projects list) leads once the projects
 * API answered — same gate as 新建项目.
 */
export type SidebarNavKey = 'projects' | 'teams' | 'automations' | 'todos' | 'people';

export interface SidebarNavEntry {
  key: SidebarNavKey;
  path: string;
  /** count that needs the user (automation decisions / incoming contact requests); 0 = none */
  attention: number;
  /** B-762: 项目 carries the tree's 需要你 total in the tree's warn tone (the others stay danger) */
  tone?: 'warn';
}

export function sidebarNavEntries(input: {
  projectsVisible?: boolean;
  /** B-762 (B-760 D1): sessions in projects that need the user (waiting + unread) */
  projectAttention?: number;
  teamsVisible: boolean;
  automationsVisible: boolean;
  automationAttention: number;
  incomingPeople: number;
}): SidebarNavEntry[] {
  const entries: SidebarNavEntry[] = [];
  if (input.projectsVisible) entries.push({ key: 'projects', path: '/projects', attention: Math.max(0, input.projectAttention ?? 0), tone: 'warn' });
  if (input.teamsVisible) entries.push({ key: 'teams', path: '/teams', attention: 0 });
  if (input.automationsVisible) entries.push({ key: 'automations', path: '/automations', attention: Math.max(0, input.automationAttention) });
  entries.push({ key: 'todos', path: '/todos', attention: 0 });
  entries.push({ key: 'people', path: '/people', attention: Math.max(0, input.incomingPeople) });
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
 * B-676/B-713: what the sidebar top renders, as data (spec
 * 2026-10-sidebar-header). No ⋯ in the header any more. Desktop: header 🔍 ·
 * collapse, then labelled rows 新建会话 (main click = new chat, ▾ = every
 * create type) · 新建项目 (once the projects API answered) · 新建团队 (unless
 * Teams is hidden on this device), followed by the capability rows. Phone:
 * header 🔍 · ＋ (B-641's create menu, one tap) and one compact chip row
 * 项目 · 团队 · 更多 ▾ (B-756: the chips open the lists, not the create dialogs).
 */
export type SidebarHeaderControl = 'search' | 'create-menu' | 'collapse';
export type SidebarActionRow = 'new-session' | 'new-project' | 'new-team';
/** B-756 (Lead 10-22): phone chips NAVIGATE (项目 → /projects, 团队 → /teams); creating lives on those pages and in ＋. */
export type SidebarChip = 'projects' | 'teams' | 'more';

export function sidebarTopModel(input: { isDesktop: boolean; projectsReady: boolean; teamsVisible: boolean }): { header: SidebarHeaderControl[]; actions: SidebarActionRow[]; chips: SidebarChip[] } {
  const creates: ('new-project' | 'new-team')[] = [];
  if (input.projectsReady) creates.push('new-project');
  if (input.teamsVisible) creates.push('new-team');
  if (!input.isDesktop) {
    const chips: SidebarChip[] = [];
    if (input.projectsReady) chips.push('projects');
    if (input.teamsVisible) chips.push('teams');
    return { header: ['search', 'create-menu'], actions: [], chips: [...chips, 'more'] };
  }
  return { header: ['search', 'collapse'], actions: ['new-session', ...creates], chips: [] };
}

/** B-713: 新建团队 lands directly in the Teams create dialog, not on the list. */
export const NEW_TEAM_PATH = '/teams?new=1';

/** The session list keeps at least this many rows on screen before a capability row is shown. */
export const MIN_LIST_ROWS = 8;

/**
 * B-713: how many capability rows the desktop shows. `spare` is the height the
 * list and the capability block share (list height + current block height,
 * invariant while rows move between them) minus the list's minimum. Rows go in
 * priority order; while any is folded a 「更多能力」 row (same pitch) is shown
 * too, so k < total costs k + 1 rows. Never negative: with no room at all
 * everything is folded into 「更多能力」.
 */
export function fitCapabilityRows(input: { spare: number; rowPitch: number; total: number }): number {
  const { spare, rowPitch, total } = input;
  if (total <= 0) return 0;
  if (!(rowPitch > 0) || !Number.isFinite(spare)) return 0;
  if (total * rowPitch <= spare) return total;
  return Math.max(0, Math.min(total - 1, Math.floor(spare / rowPitch) - 1));
}

/** Phone 「更多 ▾」: every capability that is not already a chip (no 项目 / 团队 twice). */
export function moreMenuEntries<T extends { key: string }>(entries: readonly T[], chips: readonly SidebarChip[]): T[] {
  return entries.filter((e) => !(chips as readonly string[]).includes(e.key));
}

/** Rows shown directly vs folded into 「更多能力 ▾」 (priority order kept in both). */
export function splitCapabilities<T>(entries: readonly T[], shown: number): { shown: T[]; folded: T[] } {
  const k = Math.max(0, Math.min(entries.length, shown));
  return { shown: entries.slice(0, k), folded: entries.slice(k) };
}

/** Create menu order: 新会话 first, 新项目 second, then the rest as given. */
export function orderCreateMenu<T extends { key: string }>(items: readonly T[]): T[] {
  const rank = (k: string) => (k === 'chat' ? 0 : k === 'project' ? 1 : 2);
  return items.map((item, i) => ({ item, i })).sort((a, b) => rank(a.item.key) - rank(b.item.key) || a.i - b.i).map((x) => x.item);
}
