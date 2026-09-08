/**
 * B-332 —— 被 CLI 销毁的排队消息在 transcript 里怎么显示。
 *
 * 两种 `queue-cancel` tombstone 语义不同，靠 `cancelReason` 区分：
 *  - **web 发的**（用户自己按了「从队列移除」）：没有 reason。用户主动删的东西不该再出现，
 *    继续从 transcript 里隐藏（一直以来的行为）。
 *  - **CLI 发的**（`/clear`、`/compact`、local abort、wrapper 重启/接管吃掉了它）：带 reason。
 *    这条消息用户没删过、agent 也没跑过——**必须留在原位并标明**，否则用户的文字就凭空消失，
 *    而 B-322 修的正是「消息不知道去哪了」。
 *
 * 纯函数，`ChatList` 和 `MessageView` 共用一个判据。
 */
import type { Message, UserTextMessage } from '@/sync/typesMessage';

/** 是否留在 transcript 里（queued 的进队列区；web-canceled 隐藏；其余都显示）。 */
export function isTranscriptVisibleInput(message: Message): boolean {
    if (message.inputState === undefined) return true;
    if (message.inputState === 'canceled') return typeof message.cancelReason === 'string';
    return false;
}

export type DiscardedReasonKey = 'cleared' | 'aborted' | 'restarted' | 'unknown';

/** 把线上任意字符串收敛成有文案的 key；不认识的值不丢、走通用文案（铁律 14）。 */
export function discardedReasonKey(message: Pick<UserTextMessage, 'inputState' | 'cancelReason'>): DiscardedReasonKey | null {
    if (message.inputState !== 'canceled' || typeof message.cancelReason !== 'string') return null;
    switch (message.cancelReason) {
        case 'cleared':
        case 'aborted':
        case 'restarted':
            return message.cancelReason;
        default:
            return 'unknown';
    }
}
