/**
 * composerExpand — composer 手动展开态的纯逻辑（B-098）。
 *
 * textarea 高度上限的唯一事实源在这里（input.css 里不再写 max-height，
 * 由 AgentInput 用 inline style 落地，两处定义不再漂移）：
 *   - 常态：200px（历史值，原 AgentInput 的 MAX_TA_HEIGHT）；
 *   - 展开态：约 60% 视口高，但绝不低于常态上限——小窗口下「展开」
 *     不能反而把输入框变矮。
 */

/** 常态下 textarea 的最大高度（px）。 */
export const COMPOSER_MAX_HEIGHT = 200;

/** 展开态占视口高度的比例（~60dvh）。 */
export const COMPOSER_EXPANDED_RATIO = 0.6;

/** 当前态下的高度上限（px）。纯函数，viewportHeight = window.innerHeight。 */
export function composerHeightCap(expanded: boolean, viewportHeight: number): number {
    if (!expanded) return COMPOSER_MAX_HEIGHT;
    return Math.max(COMPOSER_MAX_HEIGHT, Math.round(viewportHeight * COMPOSER_EXPANDED_RATIO));
}
