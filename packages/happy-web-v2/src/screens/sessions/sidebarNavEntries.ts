/**
 * B-641: the sidebar's capability entries (项目 / 团队 / 自动化 / 待办 / 联系人), in
 * priority order. B-926 (spec 2026-10-sidebar-header): desktop lists them as
 * labelled rows under 新建会话 ▾ — the first DEFAULT_PINNED_COUNT stay, the
 * rest fold into one 「更多 ▾」 row, and the user can change which stay
 * (`splitNavEntries`); the phone folds them into the chip row's 「更多 ▾」.
 * 帮助 lives in the sidebar footer. Visibility gates and attention counts are
 * computed here once. B-756: 项目 (the /projects list) leads once the projects
 * API answered — same gate as 新建项目.
 */
export type SidebarNavKey = 'issues' | 'board' | 'projects' | 'teams' | 'automations' | 'todos' | 'people' | 'feedback';

export interface SidebarNavEntry {
  key: SidebarNavKey;
  path: string;
  /** count that needs the user (automation decisions / incoming contact requests); 0 = none */
  attention: number;
  /** B-762: 项目 carries the tree's 需要你 total in the tree's warn tone (the others stay danger) */
  tone?: 'warn';
  /** B-836/B-926: rarely used — never one of the default pinned rows; it sits in 「更多 ▾」 unless the user pins it */
  foldedByDefault?: boolean;
}

export function sidebarNavEntries(input: {
  projectsVisible?: boolean;
  /** B-762 (B-760 D1): sessions in projects that need the user (waiting + unread) */
  projectAttention?: number;
  teamsVisible: boolean;
  automationsVisible: boolean;
  automationAttention: number;
  incomingPeople: number;
  /** B-873 (spec 2026-11-issues §10/Q11): only once the server answered `/v1/issues` — off = the entries above, unchanged */
  issuesVisible?: boolean;
  /** B-873: my pending issues (in_review + blocked) */
  issueAttention?: number;
}): SidebarNavEntry[] {
  const entries: SidebarNavEntry[] = [];
  // B-873: Issues leads, 运行中 (/board) right after it; 待办 is folded into Issues (/todos redirects).
  if (input.issuesVisible) {
    entries.push({ key: 'issues', path: '/issues', attention: Math.max(0, input.issueAttention ?? 0), tone: 'warn' });
    entries.push({ key: 'board', path: '/board', attention: 0 });
  }
  if (input.projectsVisible) entries.push({ key: 'projects', path: '/projects', attention: Math.max(0, input.projectAttention ?? 0), tone: 'warn' });
  if (input.teamsVisible) entries.push({ key: 'teams', path: '/teams', attention: 0 });
  if (input.automationsVisible) entries.push({ key: 'automations', path: '/automations', attention: Math.max(0, input.automationAttention) });
  if (!input.issuesVisible) entries.push({ key: 'todos', path: '/todos', attention: 0 });
  entries.push({ key: 'people', path: '/people', attention: Math.max(0, input.incomingPeople) });
  entries.push({ key: 'feedback', path: '/settings/feedback', attention: 0, foldedByDefault: true });
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
 * B-676/B-713/B-896: what the sidebar top renders, as data (spec
 * 2026-10-sidebar-header). No ⋯ in the header. Desktop (and the touch drawer,
 * which renders the desktop sidebar): header 🔍 · collapse, then 新建会话 ▾
 * (main click = new chat, ▾ = every create type incl. 项目 / 团队) and the
 * capability rows (B-926: labelled, 4 pinned + 更多 ▾). B-896: 新建项目 / 新建团队 stay as labelled rows only
 * until the account has one (`projectCount` / `teamCount` 0; unknown = no row,
 * so existing accounts never see them flash in). Phone: header 🔍 · ＋ (B-641's
 * create menu, one tap) and one compact chip row 项目 · 团队 · 更多 ▾ (B-756:
 * the chips open the lists, not the create dialogs).
 */
export type SidebarHeaderControl = 'search' | 'create-menu' | 'collapse';
export type SidebarActionRow = 'new-session' | 'new-project' | 'new-team';
/** B-756 (Lead 10-22): phone chips NAVIGATE (项目 → /projects, 团队 → /teams); creating lives on those pages and in ＋. */
export type SidebarChip = 'issues' | 'projects' | 'teams' | 'more';

export function sidebarTopModel(input: { isDesktop: boolean; projectsReady: boolean; teamsVisible: boolean; issuesVisible?: boolean; projectCount?: number | null; teamCount?: number | null }): { header: SidebarHeaderControl[]; actions: SidebarActionRow[]; chips: SidebarChip[] } {
  if (!input.isDesktop) {
    const chips: SidebarChip[] = [];
    // B-873: Issues is a first-level entry, so it takes the first chip on the phone too.
    if (input.issuesVisible) chips.push('issues');
    if (input.projectsReady) chips.push('projects');
    if (input.teamsVisible) chips.push('teams');
    return { header: ['search', 'create-menu'], actions: [], chips: [...chips, 'more'] };
  }
  const actions: SidebarActionRow[] = ['new-session'];
  if (input.projectsReady && input.projectCount === 0) actions.push('new-project');
  if (input.teamsVisible && input.teamCount === 0) actions.push('new-team');
  return { header: ['search', 'collapse'], actions, chips: [] };
}

/** B-713: 新建团队 lands directly in the Teams create dialog, not on the list. */
export const NEW_TEAM_PATH = '/teams?new=1';

/**
 * B-896/B-926: the desktop entry rows are one Tab stop (roving tabindex).
 * ↓/↑ (and →/← as before) wrap, Home/End jump; any other key is not the
 * group's (null).
 */
export function stripFocusTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return index >= last ? 0 : index + 1;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return index <= 0 ? last : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/** B-896: an entry is the current page on its own path and below it (/issues/VH-3 keeps Issues current). */
export function isEntryCurrent(entryPath: string, pathname: string): boolean {
  return pathname === entryPath || pathname.startsWith(`${entryPath}/`);
}

/** Phone 「更多 ▾」: every capability that is not already a chip (no 项目 / 团队 twice). */
export function moreMenuEntries<T extends { key: string }>(entries: readonly T[], chips: readonly SidebarChip[]): T[] {
  return entries.filter((e) => !(chips as readonly string[]).includes(e.key));
}

/** Create menu order: 新会话 first, 新项目 second, then the rest as given. */
export function orderCreateMenu<T extends { key: string }>(items: readonly T[]): T[] {
  const rank = (k: string) => (k === 'chat' ? 0 : k === 'project' ? 1 : 2);
  return items.map((item, i) => ({ item, i })).sort((a, b) => rank(a.item.key) - rank(b.item.key) || a.i - b.i).map((x) => x.item);
}

/**
 * B-926: how many entry rows the desktop sidebar keeps by default. Four 28px
 * rows + 「更多」 keep the session list at 86% of its B-896 height at 1080p
 * (81% at 1440×900); the
 * default four (Issues · 运行中 · 项目 · 团队, or 项目 · 团队 · 自动化 · 待办
 * without Issues) are the daily destinations, the rest are setup-like pages.
 */
export const DEFAULT_PINNED_COUNT = 4;

/**
 * B-926: split the desktop entries into the pinned rows and the 「更多 ▾」
 * menu, both in priority order. `pinned` is the user's choice (keys, any
 * order; unknown / currently invisible keys are ignored); null = default.
 */
export function splitNavEntries<T extends { key: string; foldedByDefault?: boolean }>(entries: readonly T[], pinned: readonly string[] | null): { pinned: T[]; more: T[] } {
  const keep = pinned ? new Set(pinned) : new Set(entries.filter((e) => !e.foldedByDefault).slice(0, DEFAULT_PINNED_COUNT).map((e) => e.key));
  return { pinned: entries.filter((e) => keep.has(e.key)), more: entries.filter((e) => !keep.has(e.key)) };
}

/**
 * B-926: pin / unpin one entry. The result is the explicit pinned key list
 * (the default materialised first), keeping keys of entries that are hidden
 * right now (e.g. Issues while its API is down) so they come back pinned.
 */
export function togglePinnedEntry(entries: readonly { key: string; foldedByDefault?: boolean }[], pinned: readonly string[] | null, key: string): string[] {
  const current = pinned ? [...pinned] : splitNavEntries(entries, null).pinned.map((e) => e.key);
  return current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
}
