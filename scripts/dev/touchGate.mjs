/**
 * B-798 (U1 / U3) —— device-shots 的触屏门禁名单。
 *
 * device-shots 在粗指针预设下量两样东西，不在名单里就失败：
 *   - smallTargets  宽或高 < 44px 的可见可点控件（::before/::after 扩出的热区计入，行内文字链接放行）；
 *   - hiddenActions 有 aria-label 却排成 0×0、而所在行在屏幕上的按钮（hover 才显示，触屏只能长按）。
 * 键是 `tag.首个类名`，没有类名时是 `tag in .最近祖先的首个类名`（device-shots --verbose 会打印）。
 * 名单只减不增：每条写清归属（哪个 PR 修，或为什么本来就该这样）；修好就删。
 */

/** @type {Map<string, string>} key → owner / reason */
export const SMALL_TARGET_ALLOWLIST = new Map([
    ['a in .pj-settings-nav', 'B-798 PR E（项目设置导航）'],
    ['a.settings-return', 'B-798 PR E（设置页）'],
    ['button.set-header__back', 'B-798 PR E（设置页 32px 图标按钮）'],
    ['button.set-switch', 'B-798 PR E（设置开关）'],
    ['a.vh-trail-link', 'B-798 PR E（面包屑段）'],
    ['button.bd-card-done', 'B-798 PR D（看板 ✓）'],
    ['button.bd-btn', 'B-798 follow-up（任务看板工具栏）'],
    ['button.bd-toggle-btn', 'B-798 follow-up（任务看板视图切换）'],
    ['button.vh-toast-x', 'B-798 follow-up（toast ✕）'],
    ['a in .team-project-line', 'B-798 follow-up（团队页的「打开项目」链接）'],
    ['a in .teams-heading-actions', 'B-798 follow-up（团队页标题旁的指南链接）'],
    ['button.sb-tree-link', '空项目提示里的句中文字按钮（WCAG 2.5.8 inline 例外，排版为 inline-flex）'],
]);

/** @type {Map<string, string>} */
export const HIDDEN_ACTION_ALLOWLIST = new Map([
    ['button.sb-project-act', 'B-798 PR C（侧栏项目组头 ＋ / ⋯）'],
    ['button.nc-head-btn', '通知面板的 ✕ 只在全屏（手机）形态显示；浮层形态用 Esc / 点外部关闭'],
]);

/** 不在名单里的条目（`{ key }` 按 key 匹配）。 */
export function notAllowed(found, allowlist) {
    return found.filter((t) => !allowlist.has(t.key));
}
