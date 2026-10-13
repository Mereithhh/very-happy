/**
 * B-579 —— 「你的提问」导航：条目、刻度位置、当前项与前后跳转。
 *
 * 做法参考 Orca `NativeChatMessageRail` / `native-chat-active-rail-item`（MIT）。不同点：
 * Orca 的 transcript 有虚拟化、刻度等距堆叠；这里 ChatList 没有虚拟化（B-044），刻度按消息
 * 在会话中的位置比例分布，位置直接量 DOM。
 *
 * 入参是 `buildChatRows` 的 rows，已是旧→新（铁律 15）；未加载的更早历史没有 row，也就没有刻度。
 */
import type { Message, UserTextMessage } from '@/sync/typesMessage';
import type { ChatRow } from './chatTurns';
import { parseLocalCommandMessage, parseTaskNotification, stripHarnessBlocks } from './harness';
import { stripAttachedFiles } from './attachedFiles';
import { presentTeamMessage } from './teamMessage';
import { presentSessionPeerMessage } from './sessionPeerMessage';

export type RailItem = {
    /** user-text 消息 id；DOM 上是 `[data-chat-prompt-id]`。 */
    id: string;
    /** 你的话，压成一行并截断；空串 = 只有附件。 */
    text: string;
    /** 这一轮第一条可见 agent 正文的首个非空行；还没有回答时为空。 */
    reply: string;
};

export const RAIL_TEXT_MAX = 120;
/** 跳到某条提问时，让它离滚动容器顶部留这么多空。 */
export const RAIL_SCROLL_MARGIN = 12;
/** 对话列右侧留白至少这么宽才画轨道（轨道 24px + 离滚动条的距离）。 */
export const RAIL_MIN_GUTTER = 48;
/** 与 ChatList 的「贴底」同一阈值。 */
const AT_BOTTOM_PX = 80;

export function truncateRailText(text: string, max = RAIL_TEXT_MAX): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function firstReplyLine(text: string): string {
    for (const line of stripHarnessBlocks(text).split('\n')) {
        const cleaned = line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '').replace(/[*_`]/g, '').trim();
        if (cleaned && !/^(?:```|~~~)/.test(line.trim())) return truncateRailText(cleaned);
    }
    return '';
}

/** 一条 user-text 作为「你的提问」时的标签；不是提问（任务通知、团队/跨会话卡片、caveat）返回 null。 */
export function promptLabel(message: UserTextMessage): string | null {
    const raw = message.displayText ?? message.text;
    if (parseTaskNotification(raw)) return null;
    if (presentTeamMessage(message) || presentSessionPeerMessage(message)) return null;
    const parsed = parseLocalCommandMessage(raw);
    if (parsed.kind === 'caveat') return null;
    if (parsed.kind === 'command-run') return truncateRailText(`/${parsed.commandName}${parsed.args ? ` ${parsed.args}` : ''}`);
    return truncateRailText(stripAttachedFiles(stripHarnessBlocks(parsed.text)));
}

function isAgentAnswer(message: Message): message is Extract<Message, { kind: 'agent-text' }> {
    return message.kind === 'agent-text' && !message.isThinking;
}

export function railItemsFromRows(rows: readonly ChatRow[]): RailItem[] {
    const items: RailItem[] = [];
    let current: RailItem | null = null;
    for (const row of rows) {
        if (row.type === 'activity') {
            // B-519: a turn opened by a task notification is not the user's.
            if (row.trigger) current = null;
            continue;
        }
        if (row.type !== 'message') continue;
        const message = row.message;
        if (message.kind === 'user-text') {
            // AskUserQuestion answers are projected as user rows (`<id>:answer`).
            if (row.key.endsWith(':answer')) continue;
            const label = promptLabel(message);
            if (label === null) {
                current = null;
                continue;
            }
            current = { id: message.id, text: label, reply: '' };
            items.push(current);
            continue;
        }
        if (current && !current.reply && isAgentAnswer(message)) {
            current.reply = firstReplyLine(message.text);
        }
    }
    return items;
}

/** 刻度位置：消息顶部在内容总高中的比例（0–100）。 */
export function railTickPercent(top: number, total: number): number {
    if (!(total > 0)) return 0;
    return Math.min(100, Math.max(0, (top / total) * 100));
}

export type RailViewport = { scrollTop: number; clientHeight: number; scrollHeight: number };

export function isAtBottom(view: RailViewport): boolean {
    return view.scrollHeight - view.clientHeight - view.scrollTop < AT_BOTTOM_PX;
}

/**
 * 当前在读的是哪一条提问。贴底时是最后一条（短的最后一轮不会让上一条亮）；否则是
 * 视口顶部 1/4 处之上的最后一条——读一条很长的回答时，亮的仍是引出它的那句提问。
 * `tops` 为各提问在滚动内容里的 offsetTop，升序。视口在第一条提问之上时返回 -1。
 */
export function activeRailIndex(tops: readonly number[], view: RailViewport): number {
    if (tops.length === 0) return -1;
    if (isAtBottom(view)) return tops.length - 1;
    const fold = view.scrollTop + view.clientHeight * 0.25;
    let index = -1;
    for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= fold) index = i;
        else break;
    }
    return index;
}

/** 跳到某条提问时的 scrollTop。 */
export function railScrollTarget(top: number): number {
    return Math.max(0, top - RAIL_SCROLL_MARGIN);
}

/**
 * 「上一条 / 下一条提问」：以「跳过去后提问所在的那条线」（scrollTop + 留白）为基准，
 * 上一条 = 线之上最近的一条，下一条 = 线之下最近的一条。没有则 null。
 */
export function adjacentPromptIndex(tops: readonly number[], scrollTop: number, direction: -1 | 1): number | null {
    const line = scrollTop + RAIL_SCROLL_MARGIN;
    if (direction < 0) {
        for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < line - 2) return i;
        return null;
    }
    for (let i = 0; i < tops.length; i++) if (tops[i] > line + 2) return i;
    return null;
}

/** 焦点在轨道上时的按键：↑/↓ 前后一条，Home/End 首尾；其他键 null。 */
export function railKeyStep(key: string, index: number, count: number): number | null {
    if (count === 0) return null;
    let next: number;
    if (key === 'ArrowDown') next = index + 1;
    else if (key === 'ArrowUp') next = index - 1;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = count - 1;
    else return null;
    return Math.min(count - 1, Math.max(0, next));
}

/** 桌面轨道：细指针、右侧留白够宽、至少两条提问。 */
export function shouldShowRail(input: { finePointer: boolean; gutter: number; count: number }): boolean {
    return input.finePointer && input.gutter >= RAIL_MIN_GUTTER && input.count >= 2;
}
