/**
 * B-320 —— 「点停止也无法停止」的三分判据。
 *
 * 用户实报：会话显示在跑、Stop 按钮在、按下去毫无反应。今天点停止失败时用户得到的是
 * **零个信号**：`doAbort` 把异常吞成 `return false`，而唯一调用点 `void doAbort()`
 * 连返回值都不读。下面这些完全不同的失败在屏幕上长得一模一样：
 *  ① wrapper 侧根本没有活跃 query（`claudeRemoteLauncher` 的 `abort()` 在
 *     `abortController` 为 null 时静默 no-op，并回一个**成功 ack**）；
 *  ② RPC handler 抛错——按铁律 17 它经**正常 ack** 回 `{ error }`，不是 reject；
 *  ③ 链路超时。
 *
 * ②③ 现在都会 reject，但**必须分开报**：`doAbort` 等的是整个 SDK query 解开
 * （`abort()` 里 `await abortFuture.promise`），而 relay 的 RPC 上限是 30s。一个真的
 * 停下来了、只是收尾慢的 turn 会先超时；若把它报成「停止失败」，几秒后 transcript 又
 * 冒出「已由你停止」，用户同屏看到两个互相矛盾的结论。所以超时说「已发出，仍在收尾」。
 *
 * ① 只能靠 CLI 正向回报「无事可中止」才分得出来，那需要能力位、且对已经在跑的旧
 * wrapper 永远无效（铁律 7/14），所以不在本次范围内——本模块只保证 ②③ 不再静默。
 */
import { isTimeoutError } from '@/sync/rpcTimeout';

export type AbortOutcome = 'ok' | 'timeout' | 'failed';

/** 把 `sessionAbort` 抛出的东西分类。仅用于 catch 分支。 */
export function abortOutcomeForError(error: unknown): Exclude<AbortOutcome, 'ok'> {
    return isTimeoutError(error) ? 'timeout' : 'failed';
}
