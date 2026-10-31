/**
 * B-854 — the user message a runner has taken off its queue but not yet handed
 * to the agent (Codex `turn/start` accepted, ACP `session/prompt` sent).
 *
 * In that window the message is neither in the queue (so `discardAll` misses
 * it) nor in the agent (so it never ran): a pre-flight failure (unsupported
 * effort, app-server/agent start, thread start) or a kill / signal ended it
 * with an error line at most, and the web kept painting the text as sent. Every
 * message must end as run, still queued, or a `queue-cancel` tombstone with a
 * reason the web shows as 「未执行 · 原因」 with 「放回输入框」 — this holds the
 * keys until one of the first two is proven, and tombstones them otherwise.
 *
 * Idempotent: whichever of the turn's own catch and the exit path reports
 * first wins; the other is a no-op.
 */
import type { QueueDiscardReason } from './MessageQueue2';

export class HeldInput {
    private keys: string[] | null = null;

    constructor(private readonly tombstone: (keys: string[], reason: QueueDiscardReason) => void) {}

    /** The runner took this batch off its queue; it has not reached the agent yet. */
    hold(sourceIds: readonly string[] | undefined): void {
        this.keys = sourceIds && sourceIds.length > 0 ? [...sourceIds] : null;
    }

    /** The agent has it (it runs, or fails as its own turn): nothing to report. */
    delivered(): void {
        this.keys = null;
    }

    get holding(): boolean {
        return this.keys !== null;
    }

    /** It will never reach the agent: tell the web why. True when something was reported. */
    drop(reason: QueueDiscardReason): boolean {
        const keys = this.keys;
        this.keys = null;
        if (!keys) return false;
        this.tombstone(keys, reason);
        return true;
    }
}
