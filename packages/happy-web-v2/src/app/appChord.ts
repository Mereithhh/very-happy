/**
 * appChord — 「这个按键组合是不是一个 APP 级和弦」的唯一判据。
 *
 * 为什么需要它：全站的 window-capture 快捷键原本一律写成
 * `e.metaKey || e.ctrlKey`，在 macOS 上这等于**把 Ctrl 组合也当成 app 和弦吃掉**，
 * 而 Ctrl 组合在终端里是 readline 的核心按键：
 *
 *   Ctrl+K = kill-line、Ctrl+J = accept-line、Ctrl+N = next-history、
 *   Ctrl+R = reverse-search-history
 *
 * 2026-08-14 的按键 golden 差分实测坐实：`Ctrl+K` 会弹出命令面板并夺走焦点、
 * `Ctrl+J` 被静默吞掉，两条路径（新旧输入实现）都一个字节发不出去——因为它们
 * 在**输入路径之上**就被 window capture 截走了。
 *
 * 判据：
 *   - macOS：app 和弦 = ⌘（Ctrl 留给终端）；
 *   - 其它平台：app 和弦 = Ctrl（那里 ⌘ 不存在；Linux 终端惯例是 app 用 Ctrl、
 *     终端的复制粘贴走 Ctrl+Shift，本仓沿用该惯例，不在本次改动范围内）。
 *
 * ⚠️ 只用于 window-capture 的 app 级和弦。组件内部的「⌘/Ctrl+Enter 提交」这类
 * 局部快捷键不受此约束（它们作用域在自己的输入框里，不会截走终端的键）。
 */

export const IS_MAC =
  typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/** 该事件是否按下了本平台的 app 和弦修饰键（mac=⌘，其它=Ctrl）。纯函数。 */
export function isAppChord(
  e: { metaKey: boolean; ctrlKey: boolean },
  isMac: boolean = IS_MAC,
): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}
