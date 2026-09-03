import { hashObject } from '@/utils/deterministicJson';
import type { EnhancedMode } from './loop';

/**
 * The relaunch hash for a Claude session's message queue.
 *
 * It answers exactly ONE question: does this message need a FRESH SDK Query?
 * A change to anything listed here means the running Claude Code process must
 * be replaced and the message replayed into its successor.
 *
 * `model` is deliberately NOT here. The SDK can move it on a live Query with
 * `setModel`, which is verifiable both ways (a bad alias rejects; `modelUsage`
 * on the next result proves the new model billed — see claudeLiveModel.ts), so
 * claudeRemote applies a model change at the turn boundary instead: no respawn,
 * no transcript reload, and no dependency on the park-and-replay path.
 * `fallbackModel` stays, because it is only read at Query creation.
 *
 * `effort` stays too, and NOT because the SDK lacks a live setter — it has one.
 * `Query.applyFlagSettings({ effortLevel })` resolves, but probing the pinned
 * SDK on 2026-09-03 showed it also resolves for `effortLevel: 'nonsense'`, and
 * `system/init` carries no effort field, so there is no way to tell an applied
 * switch from a silently ignored one. A relaunch costs ~700ms and is provably
 * correct; a live call is cheaper and unfalsifiable. Correctness wins until the
 * SDK reports the effort actually in force.
 *
 * This is also the batching key for MessageQueue2, so anything omitted here can
 * differ WITHIN one merged turn — collectBatch keeps the newest item's mode for
 * exactly that reason.
 */
export function claudeModeHash(mode: EnhancedMode): string {
    return hashObject({
        isPlan: mode.permissionMode === 'plan',
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools,
        effort: mode.effort,
    });
}
