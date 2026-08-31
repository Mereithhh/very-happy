/**
 * 回前台后的 socket 存活判定 —— 纯函数（spec `specs/2026-08-web-resume-sync.md` §B）。
 *
 * 执行层（apiSocket.checkLiveness）的固定顺序：
 *   1. `sendAppState()`：一次 emit。socket.io-client 每次 emit 都查 `engine._hasPingExpired()`
 *      （Date.now() 比较，不受页面冻结影响）；后台 ≥ 最后一次 ping + 60s 时这一 emit 就会
 *      在**下一个微任务**把 engine 关掉并交给 manager 自动重连。
 *   2. `await Promise.resolve()`：让那条 `_onClose` 链（engine close → manager onclose →
 *      socket onclose，全程同步）先跑完。
 *   3. 读 `socket.connected` → `decideProbe`。
 *   4. 已连才发 `ping` ack 探活（server `pingHandler` 对所有 clientType 注册，
 *      **不带 payload**：handler 的第一个参数就是 callback）。
 *   5. 探活结束 → `decideAfterProbe`：超时或 reject 一律先再校验「仍是同一 socket 且
 *      connected 且没有 handover」才算死——探活在途时排队的 `close` 派发会用
 *      `_clearAcks` reject 它，此时 manager 已在退避，再 `disconnect()` 会杀掉它自己的重连。
 *
 * 不用入站包判活：出站单向死（浏览器 WebSocket 已 CLOSING 时 `send()` 静默丢弃）时
 * 入站仍可能有包，那会把死链路判成活。
 */

/** 蜂窝无线电唤醒 0.5–2s + RTT；3s 会误判，误判代价是 reject 所有在途 ack + 全量重拉。 */
export const LIVENESS_PROBE_MS = 5_000;

export type ProbeDecision = 'probe' | 'skip';

export function decideProbe(input: { connectedAfterEmit: boolean; handoverInFlight: boolean }): ProbeDecision {
    if (!input.connectedAfterEmit) return 'skip'; // manager 自动重连在跑；不碰 io.open()
    if (input.handoverInFlight) return 'skip';    // handover 落定后再补一次
    return 'probe';
}

export type AfterProbeDecision = 'alive' | 'reconnect' | 'none';

export function decideAfterProbe(input: {
    acked: boolean;
    sameSocket: boolean;
    connected: boolean;
    handoverInFlight: boolean;
}): AfterProbeDecision {
    if (input.acked) return 'alive';
    if (!input.sameSocket || !input.connected || input.handoverInFlight) return 'none';
    return 'reconnect';
}
