/**
 * B-317 —— 用户中止之后，子代理卡不许继续说自己在跑（也不许改口说「已完成」）。
 *
 * 现象：点「终止」，transcript 立刻出现「已由你停止」，但底部的 loading 还在转。
 * 两条信息走的是两条路，先后是结构性的，不是偶然抖动：
 *  ① `Aborted by user` 服务事件在 `claudeRemote()` 返回后**立刻**发出
 *     （claudeRemoteLauncher 的 try 尾部）；
 *  ② 给每个未收尾的 tool_use 补发的 `[Request interrupted by user]` tool_result
 *     在其后的 finally 里才生成，还要再过一遍 250ms 的 tool_use 排序队列。
 * 所以「已由你停止」必然先到；这段窗口里子代理卡仍是 running，而
 * `countRunningSubagentCards` 是 agentLiveness 的第三张票（sync/agentLiveness.ts），
 * 于是整个会话继续显示为活的。后台子代理（`async_launched`）更糟：它的 stop 只来自
 * `task_notification`，中止之后永远不会到，卡会**永久** running。
 *
 * 反方向还有一个谎：那条补发的 tool_result 没有 `tool_use_result`，CLI 的 mapper
 * 走 `maybeEmitSubagentStop` 发一个**裸 stop**，而裸 stop 在 web 侧被归一化成
 * `completed`——被你亲手打断的子代理，最后显示成「✓ 已完成」。
 *
 * 两个方向用同一条判据修：**用户中止之后，任何没有交出真实结果（result / usage）的
 * 子代理卡都按「已停止」呈现**，并且不再为「会话此刻是否在跑」投票。带 result/usage
 * 的卡是真的跑完了（报告在中止前就发出来了），保持它自己的状态。
 *
 * 判据放在 web 而不是 CLI：铁律 14——已经在跑的 wrapper 不随 daemon 升级换代码，
 * 只改 CLI 救不了任何一个当前开着的会话。CLI 侧补发 `status: 'stopped'` 让语义更干净，
 * 是后续项（B-318），不是这条的替代。
 */
import type { Message, SubagentLifecycle, ToolCallMessage } from '@/sync/typesMessage';
import { presentServiceEvent } from './serviceEvent';

/**
 * 最后一次「已由你停止」服务事件的时间；没有则 null。
 * 入参须为**时间升序**（与 currentTurnMessages 同一契约）。
 */
export function userAbortedAt(messages: Message[]): number | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.kind !== 'agent-event' || message.event.type !== 'message') continue;
        if (presentServiceEvent(message.event.message).kind === 'stopped') return message.createdAt;
    }
    return null;
}

/** 这张卡是不是真的交出过结果——有就不是被中止掐掉的。 */
function reportedRealOutcome(lifecycle: SubagentLifecycle): boolean {
    return lifecycle.result !== undefined || lifecycle.usage !== undefined;
}

/**
 * 这张子代理卡该显示成什么状态。没有 CLI 生命周期时返回 undefined（保持 B-260
 * 第一批的「诚实指针行」：不声称状态）。
 */
export function presentedSubagentStatus(
    message: ToolCallMessage,
    abortedAt: number | null,
): SubagentLifecycle['status'] | undefined {
    const lifecycle = message.subagent;
    if (!lifecycle) return undefined;
    // 中止之后开的卡不受这条约束（用户中止的是上一轮）。
    if (abortedAt === null || message.createdAt > abortedAt) return lifecycle.status;
    if (lifecycle.status === 'failed' || lifecycle.status === 'stopped') return lifecycle.status;
    // `running` is unconditional: the abort killed the process, so nothing that
    // was still running survived it. Progress payloads (task_progress carries
    // tokens and a tool count) must NOT buy a card out of this — only a stop
    // event carries a real outcome, and a stop is by definition not `running`.
    if (lifecycle.status === 'running') return 'stopped';
    return reportedRealOutcome(lifecycle) ? lifecycle.status : 'stopped';
}
