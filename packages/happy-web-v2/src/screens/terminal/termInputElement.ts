/**
 * termInputElement —— 「谁是终端的键盘输入元素」的**唯一判据**（纯，零依赖）。
 *
 * spec: `specs/2026-08-terminal-input-ownership.md` §设计 A / §风险 R1
 *
 * 为什么要一个模块只放两个常量和一个谓词：输入所有权改造之后，「终端有键盘焦点」
 * 这件事有**两种**元素可能成立 —— 旧路径的 `.xterm-helper-textarea` 与新路径的
 * `.vh-term-input`。而这个判定散落在四个互不相识的地方：
 *   - `app/closeGuard.ts`（⌥W 的「终端里也要生效」豁免）
 *   - `app/viewShortcuts.ts`（取消关闭后归还焦点的 fallback 目标）
 *   - `ui/Menu.tsx`（Radix 菜单关闭后把焦点还给终端）
 *   - `screens/terminal/termFocusOwnership.ts`（焦点归属分类）
 * 历史事故（2026-08-14，B-093）的持续性那一半正是「归还焦点是三处各写一遍的偶然
 * 行为，第四处忘了写」。再多一种输入元素而判据仍然是四份 hardcode 的 class 名，
 * 就是把同一个事故的下一次复发提前写好。所以判据只有这一份。
 *
 * 纪律：本文件**零 import、零 DOM 类型依赖**（鸭子类型），因为 `closeGuard.ts`
 * 必须能在 node 测试环境里被 import（见那个文件的头注：`@/text` 在 import 期就读
 * 持久化设置，把它拽进来会直接抛异常）。
 */

/** 旧路径：xterm 自己的隐藏 helper textarea。 */
export const XTERM_HELPER_CLASS = 'xterm-helper-textarea';

/** 新路径：我们自有的、挂在 `term.element` 内部的受控输入元素。 */
export const TERM_INPUT_CLASS = 'vh-term-input';

/**
 * 两条路径的并集选择器。**只许有一个匹配**（结构断言，spec §风险 R4）：
 * 新旧路径同时安装 = 一次按键写两遍 PTY。
 */
export const TERM_INPUT_SELECTOR = `.${TERM_INPUT_CLASS},.${XTERM_HELPER_CLASS}`;

interface ElementLike {
    classList?: { contains(name: string): boolean };
}

/**
 * 这个节点是不是「终端的键盘输入元素」（两条路径任一）。
 * 鸭子类型 + 无 `instanceof`：可在 node 下测，也免疫跨 realm 的 instanceof 陷阱。
 */
export function isTerminalInputElement(t: unknown): boolean {
    const el = t as ElementLike | null | undefined;
    return (
        el?.classList?.contains?.(TERM_INPUT_CLASS) === true
        || el?.classList?.contains?.(XTERM_HELPER_CLASS) === true
    );
}
