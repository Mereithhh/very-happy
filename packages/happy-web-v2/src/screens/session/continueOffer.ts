/**
 * B-578 —— 「已由你停止」行上的「继续」。
 *
 * 只给**最近一次**停止、且它之后还没有任何 user-text（用户消息或任务通知——agent 已被别的
 * 输入接上）的那一行。入参是 transcript 的旧→新数组（铁律 15）。
 */
import type { Message } from '@/sync/typesMessage';
import { presentServiceEvent } from './serviceEvent';

export function isUserStopEvent(message: Message): boolean {
    return message.kind === 'agent-event'
        && message.event.type === 'message'
        && presentServiceEvent(message.event.message).kind === 'stopped';
}

export function continueOfferStopId(chronological: readonly Message[]): string | null {
    for (let i = chronological.length - 1; i >= 0; i--) {
        const message = chronological[i];
        if (message.kind === 'user-text') return null;
        if (isUserStopEvent(message)) return message.id;
    }
    return null;
}

/** 发出的那条消息就是按钮上的字：中文「继续」、繁中「繼續」，其余 Continue。 */
export function continueMessageText(lang: string | undefined): string {
    const code = lang ?? '';
    if (/^zh[-_](hant|tw|hk|mo)/i.test(code)) return '繼續';
    return code.startsWith('zh') ? '继续' : 'Continue';
}
