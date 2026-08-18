/**
 * RPC 超时识别（B-138）—— 纯函数、零 import。
 *
 * 单独成模块是因为 `fsOps.ts` 的 import 链会拽进 apiSocket → persistence →
 * localStorage，在 node 测试环境里加载不了。判超时是纯字符串逻辑，不该被那条链绑架。
 */

/**
 * socket.io 客户端的 `.timeout(ms)` 超时后 reject 一个 Error，消息形如
 * "operation has timed out"。这里放宽到 timeout/timed out 两种写法。
 */
export function isTimeoutError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return /timed?\s*out/i.test(msg);
}
