/**
 * 外部 todo provider 的失败码映射（B-007）—— 纯函数、零 import。
 *
 * 单独成模块有两个原因：
 *  1. `todoOps.ts` 的 import 链会拽进 apiSocket → localStorage，node 测试环境加载不了；
 *  2. 这里正是 **B-003 那个坑**最容易复发的地方——daemon 侧 handler 抛的错会被
 *     `RpcHandlerManager` 编码成 `{error}` 的**正常响应**，调用方必须显式检查 `error`
 *     字段而不是只靠 try/catch。映射错了的表现是「界面显示 unknown error」而不是崩，
 *     所以不测就发现不了。
 */

export type TodoFailureCode =
    /** 这台机器没配 provider —— 不是错误，是「功能没开」，UI 要给引导而不是报错 */
    | 'not-configured'
    /** daemon 太旧（没注册这几个 RPC）或机器离线 —— relay 对两者的回答一样 */
    | 'unsupported'
    | 'timeout'
    /** provider 自己非零退出，detail 里带着它的 stderr —— 要原样显示给用户 */
    | 'provider-error'
    | 'bad-output'
    | 'unknown';

export interface TodoFailure {
    ok: false;
    code: TodoFailureCode;
    error: string;
}

/** daemon 侧统一用 `<code>: <detail>` 的形状抛错；这里只认这几个前缀。 */
const PREFIXED: readonly TodoFailureCode[] = ['not-configured', 'provider-error', 'bad-output', 'timeout'];

export function todoFailureOf(error: string): TodoFailure {
    // server 对「旧 daemon 没注册该方法」和「机器离线」的回答是同一句，无法区分
    if (error === 'RPC method not available' || error === 'Method not found') {
        return { ok: false, code: 'unsupported', error };
    }
    for (const code of PREFIXED) {
        if (error === code) return { ok: false, code, error };
        if (error.startsWith(`${code}:`)) {
            const detail = error.slice(code.length + 1).trim();
            return { ok: false, code, error: detail || error };
        }
    }
    return { ok: false, code: 'unknown', error };
}
