/**
 * B-641: the sidebar's secondary "Workspace" entries (团队 / 自动化 / 待办 /
 * 联系人 / 帮助). ONE list feeds both presentations so they cannot drift:
 *  - desktop (two-pane shell): the always-visible nav column under 新建会话;
 *  - phone (single-pane list): the header's ⋯ menu, so the session list gets
 *    the screen height instead of six 44px nav rows (spec 2026-10-mobile-sidebar).
 * Visibility gates and attention counts are computed here once.
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
