/**
 * 流式草稿的重渲节流（B-354）。
 *
 * react-markdown 没有内部缓存：每次渲染都重新 parse 整篇。`LiveStreamView` 每秒重渲
 * ~12 次，实测（node，renderToStaticMarkup）单次 parse+render：4 KB 8.5 ms、16.5 KB
 * 38 ms，手机再乘 3–5——不节流的话一条长回答流式期间就吃掉半条主线程。
 *
 * **与按块 memo 的关系（B-610）**：B-354 时按块 memo 被否决，理由是表格和列表内部没有空行、
 * 切不开，而且朴素切法会把松散列表切成多个 `<ol>`、让脚注/引用式链接跨块失效。B-610 用
 * 保守切分器（markdownBlocks.ts，DOM 与整篇渲染逐字节一致）补上了散文/混合形状
 * （20 KB 混合回答按 20 字一块流式：7.8 s → 0.22 s 渲染总耗时），但**单张大表/长列表仍是
 * 一块**，收益为零——所以这个与文本形状无关的节流继续保留，两者叠加。
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
