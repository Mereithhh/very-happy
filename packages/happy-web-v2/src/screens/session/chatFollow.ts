/**
 * chatFollow — 滚动跟随的纯逻辑（B-099）。
 *
 * 两个缺口的可测内核：
 * 1. 离底快照/未读增量：用户离开底部那一刻记下 row 数快照；之后每多一条 row
 *    就是一条「新消息」，回到底部清零。给 .cl-jump 的数字 badge 用。
 * 2. 内容原地长高（同一条 tool-call 的 stdout 变长、running→done 展开）时
 *    rows.length 与最后一条消息的文本长度都不变，靠内容元素的 ResizeObserver
 *    补住——但只在「已经贴底 + 高度确实变大」时跟随，用户上滚回看绝不能被拉回。
 */

/**
 * 离底快照的状态推进：贴底时无快照（null）；离底那一刻记下当前 row 数，
 * 之后保持不变（增量以这一刻为基准）。
 */
export function nextAwaySnapshot(
    prev: number | null,
    atBottom: boolean,
    rowCount: number,
): number | null {
    if (atBottom) return null;
    return prev ?? rowCount;
}

/** 未读增量：无快照（贴底）恒为 0；否则是快照之后新增的 row 数，不为负。 */
export function unseenRows(snapshot: number | null, rowCount: number): number {
    if (snapshot === null) return 0;
    return Math.max(0, rowCount - snapshot);
}

/** badge 文案：上限 99+，0 不显示（返回 null）。 */
export function formatUnseen(count: number): string | null {
    if (count <= 0) return null;
    return count > 99 ? '99+' : String(count);
}

/** 内容高度变化时是否应贴底跟随：仅当「已贴底」且「高度增长」。 */
export function shouldFollowGrowth(
    prevHeight: number,
    nextHeight: number,
    atBottom: boolean,
): boolean {
    return atBottom && nextHeight > prevHeight;
}

/**
 * 滚动容器自身变矮时是否应保持贴底（B-114）：软键盘弹起 resize 视口把容器
 * 压矮，内容高度不变——growth 那条路永远不触发，贴底状态就丢了。仅当
 * 「已贴底」且「容器变矮」时跟随；用户上滚回看时键盘弹起不动他。
 * （容器变高——键盘收起——不需要处理：scrollTop 被浏览器 clamp，贴底自持。）
 */
export function shouldFollowShrink(
    prevHeight: number,
    nextHeight: number,
    atBottom: boolean,
): boolean {
    return atBottom && nextHeight < prevHeight;
}

/**
 * Smooth scrolling is useful for a nearby catch-up, but across a long
 * transcript it becomes slow and interruptible. Jump immediately when the
 * destination is more than two visible pages away.
 */
export function shouldSmoothJumpToLatest(distance: number, viewportHeight: number): boolean {
    return distance > 0 && viewportHeight > 0 && distance <= viewportHeight * 2;
}
