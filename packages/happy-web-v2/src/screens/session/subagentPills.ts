/**
 * 抑制与 Agent 卡重复的 subagent start/stop 药丸（B-260 第一批，纯函数）。
 *
 * 新 CLI 的 `Agent` 工具调用自带 `args.sessionSubagent`（cuid2），与
 * start/stop 生命周期事件的 `event.id` 同源（CLI 的
 * ensureSessionSubagentIdForProviderSubagent）。两者都在时，卡片是信息上位——
 * 药丸只剩噪音。判定在**渲染期**、对**全会话**建集合：
 *  - DESC 历史页里药丸可能先于卡到达，渲染期判定与到达顺序无关；
 *  - 跨 turn 的 stop 落在后面的 turn，集合必须覆盖全会话而非单 turn。
 * 兼容：Codex 与旧 CLI 只发药丸、没有带 sessionSubagent 的卡 → 集合为空 →
 * 药丸照旧渲染。
 */
import type { Message } from '@/sync/typesMessage';

export function collectSubagentCardIds(messages: Message[]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        const sessionSubagent = (message.tool.input as Record<string, unknown> | null | undefined)?.sessionSubagent;
        if (typeof sessionSubagent === 'string' && sessionSubagent.length > 0) ids.add(sessionSubagent);
    }
    return ids;
}

export function suppressSubagentPills(messages: Message[]): Message[] {
    const cardIds = collectSubagentCardIds(messages);
    if (cardIds.size === 0) return messages;
    return messages.filter((message) =>
        !(message.kind === 'agent-event'
            && message.event.type === 'subagent'
            && cardIds.has(message.event.id)));
}

/** 折叠 turn 头部的子代理计数（W6）。 */
export function countSubagentCards(messages: Message[]): number {
    let count = 0;
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        if (message.tool.name === 'Task' || message.tool.name === 'Agent') count++;
    }
    return count;
}

/** B-260-P2: sub-agent cards whose CLI-published lifecycle is still running. */
export function countRunningSubagentCards(messages: Message[]): number {
    let count = 0;
    for (const message of messages) {
        if (message.kind === 'tool-call' && message.subagent?.status === 'running') count++;
    }
    return count;
}
