/**
 * B-896 (spec 2026-10-sidebar-header): every sidebar entry the desktop folds
 * into icons is one ⌘K search away — Issues, 运行中, 项目, 自动化, 联系人 and
 * 新建项目 / 新建团队 — under the same visibility gates as the sidebar. Names
 * in both languages are in every haystack, so 「项目」 finds it in English UI.
 * 团队 / 待办 already have their own palette actions.
 */
export type PaletteNavTarget = { kind: 'path'; path: string } | { kind: 'new-project' };

export interface PaletteNavAction {
  key: string;
  icon: 'issues' | 'board' | 'projects' | 'automations' | 'people' | 'new-project' | 'new-team';
  title: string;
  haystack: string;
  target: PaletteNavTarget;
}

export function paletteNavigationActions(input: { zh: boolean; issuesVisible: boolean; projectsVisible: boolean; automationsVisible: boolean; teamsVisible: boolean }): PaletteNavAction[] {
  const { zh } = input;
  const out: PaletteNavAction[] = [];
  const add = (key: PaletteNavAction['icon'], zhTitle: string, enTitle: string, words: string, target: PaletteNavTarget) =>
    out.push({ key: `action:go-${key}`, icon: key, title: zh ? zhTitle : enTitle, haystack: `${words} ${zhTitle} ${enTitle}`.toLowerCase(), target });
  if (input.issuesVisible) {
    add('issues', 'Issues', 'Issues', 'issue 任务 list 列表', { kind: 'path', path: '/issues' });
    add('board', '运行中', 'Running', 'board running 看板 运行', { kind: 'path', path: '/board' });
  }
  if (input.projectsVisible) add('projects', '项目', 'Projects', 'project 项目列表', { kind: 'path', path: '/projects' });
  if (input.automationsVisible) add('automations', '自动化', 'Automations', 'automation schedule 定时 触发', { kind: 'path', path: '/automations' });
  add('people', '联系人', 'Contacts', 'people contacts friends 好友 联系人', { kind: 'path', path: '/people' });
  if (input.projectsVisible) add('new-project', '新建项目', 'New project', 'new project create 创建项目', { kind: 'new-project' });
  if (input.teamsVisible) add('new-team', '新建团队', 'New team', 'new team create 创建团队 happy bot', { kind: 'path', path: '/teams?new=1' });
  return out;
}
