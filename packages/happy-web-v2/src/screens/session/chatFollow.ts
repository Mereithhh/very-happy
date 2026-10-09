/**
 * chatFollow — 滚动跟随的纯逻辑（B-099）。
 *
 * 两个缺口的可测内核：
 * 1. 离底快照/未读增量：用户离开底部那一刻记下最新一行的 key；之后排在它
 *    后面的每一行就是一条「新消息」，回到底部清零。给 .cl-jump 的数字 badge 用。
 * 2. 内容原地长高（同一条 tool-call 的 stdout 变长、running→done 展开）时
 *    rows.length 与最后一条消息的文本长度都不变，靠内容元素的 ResizeObserver
 *    补住——但只在「已经贴底 + 高度确实变大」时跟随，用户上滚回看绝不能被拉回。
 */

/**
 * 离底快照的状态推进：贴底时无快照（null）；离底那一刻记下当时**最新一行**
 * 的 key，之后保持不变（增量以这一行为界）。
 *
 * 记 key 而不是 row 数：后台历史预取（sync.prefetchOlderMessagesInBackground，
 * 每 250ms 一页）把旧消息**插在顶部**，row 数照样涨。按 row 数算，离底后
 * badge 会被旧历史一路推到 99+（Xu CHEN 实报：「数字慢慢变到 99+」）。
 */
export function nextAwaySnapshot(
    prev: string | null,
    atBottom: boolean,
    newestKey: string | null,
): string | null {
    if (atBottom) return null;
    return prev ?? newestKey;
}

/**
 * 未读增量：无快照（贴底）恒为 0；否则是快照那一行**之后**的 row 数——
 * 顶部插入的旧历史不算。快照行不在了（turn 重建换了 key）时宁可不显示数字
 * 也不乱报，跳转按钮本身仍在。
 */
export function unseenRows(snapshotKey: string | null, rowKeys: readonly string[]): number {
    if (snapshotKey === null) return 0;
    const at = rowKeys.lastIndexOf(snapshotKey);
    return at < 0 ? 0 : rowKeys.length - 1 - at;
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
