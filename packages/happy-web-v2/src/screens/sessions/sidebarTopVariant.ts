/**
 * B-892 prototype switch (not for merge): which sidebar top the desktop shell
 * renders, and whether the Issues page uses the proposed improvements. Default
 * = production behaviour; only the prototype entry (src/dev/b892) changes it.
 */
import { create } from 'zustand';

export type SidebarTopVariant = 'current' | 'a1' | 'a2' | 'b';

export const useB892 = create<{ top: SidebarTopVariant; issues: boolean; set: (patch: Partial<{ top: SidebarTopVariant; issues: boolean }>) => void }>((set) => ({
  top: 'current',
  issues: false,
  set: (patch) => set(patch),
}));

/** Palette → sidebar: the 新建项目 dialog lives in Sidebar.tsx. */
export const B892_NEW_PROJECT_EVENT = 'vh:b892-new-project';

/**
 * Create rows that stay visible in a compact top: a row disappears for good
 * once the account has one of that thing, so new users still see 新建项目 /
 * 新建团队 as labelled rows and returning users only keep 新建会话.
 */
export function compactCreateRows(input: { projectsReady: boolean; projectCount: number; teamsVisible: boolean; teamCount: number }): ('new-project' | 'new-team')[] {
  const rows: ('new-project' | 'new-team')[] = [];
  if (input.projectsReady && input.projectCount === 0) rows.push('new-project');
  if (input.teamsVisible && input.teamCount === 0) rows.push('new-team');
  return rows;
}
