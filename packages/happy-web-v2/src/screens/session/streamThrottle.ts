/**
 * 流式草稿的重渲节流（B-354）。
 *
 * react-markdown 没有内部缓存：每次渲染都重新 parse 整篇。`LiveStreamView` 每秒重渲
 * ~12 次，实测（node，renderToStaticMarkup）单次 parse+render：4 KB 8.5 ms、16.5 KB
 * 38 ms，手机再乘 3–5——不节流的话一条长回答流式期间就吃掉半条主线程。
 *
 * **为什么不是「按块 memo」**：第一版方案是按空行把草稿切块、只重解析最后一块。实测
 * 它在最该管用的两种形状上收益恰好为零——**表格和列表内部没有空行**，16 KB 的表格
 * 切出 1 块（25.7 ms → 25.7 ms），bullet list 同理；而「agent 正在流式吐一张大表」正是
 * 本次要修的场景。用它还会引入可见的排版抖动（松散列表被切成多个 `<ol>`/`<ul>`、
 * 脚注与引用式链接跨块失效）。所以按块 memo 被否决，改用与文本形状无关的节流。
 *
 * 草稿是 disposable 的：1.5 秒后落地的持久化消息会整篇重新解析并替换它，所以降低
 * 草稿的刷新率不损失任何最终结果，只影响「字往外冒」的颗粒度。短文本完全不节流，
 * 保住「立刻看见开始打字」的手感。
 */

/** 单帧预算 ~8 ms 换算出来的刷新间隔；短草稿不节流。 */
export function streamThrottleMs(length: number): number {
    if (length < 2_000) return 0;      // 实测 <3 ms/帧，无需节流
    if (length < 8_000) return 120;    // ~8 fps
    if (length < 20_000) return 250;   // ~4 fps
    return 400;                        // ~2.5 fps；此时草稿早已长到没人逐字读
}
