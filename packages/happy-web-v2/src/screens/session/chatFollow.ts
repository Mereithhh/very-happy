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

/** transcript 底端的指纹：最新一行的 key + 最新一条消息的文本长度（流式增长）。 */
export type BottomEdge = { newestKey: string | null; lastContentLen: number };

/**
 * rows 变化是不是「底部来了新内容」：只有最新一行换了、或最新一条消息原地变长才算。
 * 后台历史预取（sync.prefetchOlderMessagesInBackground，每页 250ms）和「加载更早」
 * 把旧消息插在**顶部**——rows.length 照样涨，底端却没变。把它当新内容跟随，会把
 * 80px 跟随带内正在慢慢上滚（触控板）的用户一页一页拽回底部，永远滚不出去。
 */
export function isBottomEdgeChange(prev: BottomEdge, next: BottomEdge): boolean {
    return prev.newestKey !== next.newestKey || prev.lastContentLen !== next.lastContentLen;
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

/**
 * B-598：「跟随带」与「真正到底」两个阈值。
 *
 * 跟随带（80px）只用于**还没表达过离开意图**的读者：贴底时内容的小幅抖动
 * （markdown 迟到渲染、滚动条取整）不该让跟随断掉。可一旦用户做了向上滚的
 * 手势，再用 80px 带重新上膛就是 bug：触控板/慢滚轮每个事件只走几 px，两次
 * 流式 token 之间读者仍在带内，下一个 token 就把他拽回 0——永远出不去
 * （Xu CHEN 2026-10-13：「往上滚想看完整回复，会主动掉到最下面」）。
 * 脱离后只有真正回到底（≤ REATTACH_PX，留给 HiDPI 的小数 scrollTop）才重新跟随。
 */
export const FOLLOW_BAND_PX = 80;
export const REATTACH_PX = 2;

export type FollowState = { atBottom: boolean; detached: boolean };

/** 一次 scroll 事件之后的跟随状态：脱离中只认真正到底，否则沿用 80px 带。 */
export function followAfterScroll(detached: boolean, distance: number): FollowState {
    if (detached) {
        const back = distance <= REATTACH_PX;
        return { atBottom: back, detached: !back };
    }
    return { atBottom: distance < FOLLOW_BAND_PX, detached: false };
}

/** 滚轮向上（内容往回翻）才是离开意图；横向/向下滚不算。 */
export function isUpwardWheel(deltaY: number): boolean {
    return deltaY < 0;
}

/** 触摸拖动：手指向下移动 = 内容向上滚（往回看）。留一点死区防误触。 */
export function isUpwardTouch(startY: number, currentY: number, slop = 4): boolean {
    return currentY - startY > slop;
}

/**
 * 会把滚动容器往上翻的按键：PageUp / ↑ / Home / Shift+Space，以及 macOS 的
 * Cmd+↑（到顶）。Ctrl/Alt 组合交给别的快捷键，不算。
 */
export function isUpwardScrollKey(e: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
    if (e.altKey || e.ctrlKey) return false;
    if (e.key === 'ArrowUp') return true;
    if (e.metaKey) return false;
    if (e.key === 'PageUp' || e.key === 'Home') return true;
    return (e.key === ' ' || e.key === 'Spacebar') && e.shiftKey === true;
}

/**
 * B-603：transcript 在动（手指按着、惯性/平滑滚动还在出 scroll 事件）时，不往
 * 顶部插旧历史。
 *
 * 后台预取每 ~0.5s 往顶部插一页，插完要 `scrollTop += 新增高度` 把读者留在原处。
 * 但 iOS Safari（WebKit）在滚动进行中**不认**程序写 scrollTop：惯性滚动、
 * `scrollTo({ behavior: 'smooth' })` 的动画都会接着往旧目标走，补偿丢失，
 * 视图一下跳到更早的内容（新增的整页高度）。react-virtuoso 的
 * upwardScrollFixSystem 也是同一结论（"mobile safari does not support scrollBy
 * while scrolling is in progress"）。Chromium 则是补偿把平滑动画打断——没大跳，
 * 但「跳到最新」停在半路。
 *
 * 所以滚动进行中把 transcript 冻结在开始滚动时最早那条消息上（更早的照常进
 * store，只是先不渲染），停稳后一次性放出来、同一 commit 内按锚点补偿。
 */
export const SCROLL_SETTLE_MS = 180;

/** 冻结期间只渲染 `holdFromId` 及之后的消息；它不在了（被替换）就不冻结。 */
export function heldTranscript<T extends { id: string }>(chronological: T[], holdFromId: string | null): T[] {
    if (holdFromId === null) return chronological;
    const at = chronological.findIndex((message) => message.id === holdFromId);
    return at <= 0 ? chronological : chronological.slice(at);
}

/** 还要等多久才算停稳：手指按着就一直等；否则距最后一次滚动满 settleMs。0 = 已停稳。 */
export function settleWait(now: number, lastMotionAt: number, touching: boolean, settleMs = SCROLL_SETTLE_MS): number {
    if (touching) return settleMs;
    const left = lastMotionAt + settleMs - now;
    return left > 0 ? Math.ceil(left) : 0;
}

/**
 * 补偿用的锚点：可视区内第一个（底边在 `line` 之下的）子元素，且至少是第
 * `minIndex` 个——最早那一行可能在插入时被重建（同一轮拼上更早的消息，换了
 * key / DOM），拿它当锚点会丢补偿。`bottomOf(i)` 按文档顺序单调不减，二分查找。
 * 没有子元素返回 -1。
 */
export function anchorIndex(count: number, bottomOf: (index: number) => number, line: number, minIndex: number): number {
    if (count <= 0) return -1;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bottomOf(mid) > line) hi = mid;
        else lo = mid + 1;
    }
    return Math.min(count - 1, Math.max(lo, minIndex));
}
