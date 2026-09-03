/**
 * B-295 —— 「现在还在跑吗」的唯一判据。
 *
 * transcript 里的 `tool.state === 'running'` 是**最后已知状态，不是当前状态**：
 * 关闭它的那一帧（tool_result）恰恰是被杀死/重启的 wrapper 永远不会再发的东西。
 * 于是任何把 `running` 当成「此刻在忙」的地方，在一次重启之后都会永久说谎：
 * turn 头显示「耗时 2094 分钟」且永不折叠、状态条常驻「Bash · 2094m」、
 * 之后每条消息都被 `sendMessage` 打上 `queuedAt`（显示成排队中）。
 * 这三处以前各自算各自的，所以只修一处必然复发——判据收敛到本文件。
 *
 * 唯一被**持续重发**的活性信号是 wrapper 每 2s 的 keepAlive（`session.thinking`）。
 * Claude runner 在**整个 turn** 内把它按住为 true（system/init → 工具执行 → result
 * 才转 false，见 `claudeRemote.ts` 的 `updateThinking`），所以它天然覆盖了每一个
 * 真正在执行的工具——工具只能在 turn 内跑，`thinking === false` 就意味着没有工具在跑。
 *
 * 唯一合法地活过 turn 的是**后台子代理**（`async_launched`，B-260-P2：主 turn 的
 * tool_result 只是 stub，result 已经发出、thinking 已经转 false，子代理还在跑）。
 * 所以子代理保留自己的一票，但有两个约束：
 *  ① 会话必须在线（wrapper 没了就没有任何东西在跑）；
 *  ② 只认**当前 turn**内的子代理卡——用户再开口就说明上一轮已经结束，
 *     旧卡上卡死的 running 不能再让会话永远显示为活的（重启后同理）。
 *
 * 已知取舍：如果一个后台子代理卡死在 running 且用户此后没再发过消息，会话仍会显示为活的
 * ——子代理合法地在 `thinking === false` 时运行，我们没有第二个信号能把「还在跑」和
 * 「wrapper 死了」分开。用户下一次开口即自愈（那张卡不再属于当前 turn）。
 *
 * 注意 `thinkingAt` 不能用来区分「没观测过」和「观测到空闲」：REST 快照对任何
 * 非 thinking 的会话都会把它写回 0（sync.ts 的 processedSession +
 * preserveSessionActivityFromStore），所以冷启动只能接受最多约 2s 的
 * 「先当作不活、keepAlive 到了再转活」——方向是安全的（宁可晚亮，不可长亮）。
 */
import type { Message } from './typesMessage';

export type AgentLivenessInput = {
    presence: 'online' | number | undefined;
    thinking: boolean | undefined;
    /** 当前 turn 内、CLI 生命周期仍为 running 的子代理卡数量 */
    runningSubagentsInTurn: number;
};

/** 会话此刻是否真的有活在跑（唯一判据）。 */
export function isAgentWorkLive(input: AgentLivenessInput): boolean {
    if (input.presence !== 'online') return false;
    if (input.thinking === true) return true;
    return input.runningSubagentsInTurn > 0;
}

/**
 * 当前 turn = 最后一条用户消息之后的所有消息（入参须为**时间升序**）。
 * 没有任何用户消息时整段都算当前 turn。
 */
export function currentTurnMessages(messages: Message[]): Message[] {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].kind === 'user-text') return messages.slice(i + 1);
    }
    return messages;
}
