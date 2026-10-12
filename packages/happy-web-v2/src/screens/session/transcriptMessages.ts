/**
 * B-561 —— store 消息 → transcript 的时间升序视图，以及当前 turn 的在跑子代理数。
 *
 * storage 里的 `sessionMessages[id].messages` 是**新→旧**（`compareMessagesNewestFirst`，
 * 侧栏取最新一条用），而 `agentLiveness.currentTurnMessages` / `opensTurn` 要求**旧→新**
 * （铁律 15）。看板曾把新→旧数组直接传进去：从数组尾（最旧）往前找到的是会话第一条用户消息，
 * 切出来的「当前 turn」是它之前的消息——几乎总是空——于是看板/侧栏的子代理计数恒为 0，
 * 主 agent 回合结束、子代理还在跑的会话被判成空闲/等我看。
 *
 * 判据只有一份：ChatList 与看板都从这里取 `chronological`，所以 transcript 里切 turn 的
 * 那些过滤（隐藏的输入、重复附件回显、slash 命令回显、被卡片吸收的子代理药丸、隐藏工具）
 * 对两边一致——否则看板会被一条不渲染的 user-text 提前切 turn。
 */
import type { Message } from '@/sync/typesMessage';
import { currentTurnMessages } from '@/sync/agentLiveness';
import { dropSlashCommandEchoes } from './compaction';
import { isHiddenToolCall } from './toolVisibility';
import { dropDuplicateAttachmentEchoes } from './attachedFiles';
import { countRunningSubagentCards, suppressSubagentPills } from './subagentPills';
import { isTranscriptVisibleInput } from './discardedInput';

/** 入参为 storage 的**新→旧**数组；返回 transcript 可见消息的**旧→新**数组。 */
export function transcriptChronological(newestFirst: readonly Message[]): Message[] {
    // B-355: the CLI's JSONL scanner used to forward a second copy of any
    // message that carried an attachment. It has to be dropped HERE and not
    // in the renderer: `buildChatRows` splits turns on `kind === 'user-text'`
    // regardless of what renders, so leaving it in would still open an empty
    // turn, inflate `rows.length` (unseen badge) and move the liveness
    // window's start.
    // B-332: a message the CLI discarded (tombstone WITH a reason) stays in
    // the transcript, marked — the user's text must not vanish because a
    // restart/clear ate it. A web-side cancel (no reason) is the user's own
    // removal and stays hidden, as before.
    return dropSlashCommandEchoes(dropDuplicateAttachmentEchoes(suppressSubagentPills([...newestFirst].reverse().filter((message) =>
        isTranscriptVisibleInput(message) &&
        (message.kind !== 'tool-call' || !isHiddenToolCall(message.tool))))));
}

/** 当前 turn 内仍在跑的子代理卡数（入参为 storage 的**新→旧**数组）。与 ChatList 同一判据。 */
export function runningSubagentsInCurrentTurn(newestFirst: readonly Message[]): number {
    return countRunningSubagentCards(currentTurnMessages(transcriptChronological(newestFirst)));
}
