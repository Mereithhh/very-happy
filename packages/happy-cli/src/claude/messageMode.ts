/**
 * B-515: the per-message Claude mode resolution, extracted from
 * `runClaude.ts` `onUserMessage` so the SAME function computes
 *
 *   - the mode a real user message runs with (and the sticky state it leaves), and
 *   - the mode the prewarm predicts for the first message
 *     (`claudePrewarm.ts`) — CLI state + the cached web `appendSystemPrompt`.
 *
 * Identical normalization on both sides is what makes the prewarm's
 * `claudeModeHash(predicted) === claudeModeHash(actual)` comparison meaningful.
 *
 * Pure: no logging, no publishing. The caller applies `next` and publishes
 * `publishPermissionMode` when it is present.
 */
import type { MessageMeta } from '@/api/types';
import { withAssistantDenylist } from '@/assistant/dispatcherTools';
import type { ClaudeEffort, EnhancedMode, PermissionMode } from './loop';
import { resolveRemoteClaudePermissionMode } from './utils/permissionMode';

/** Sticky per-process mode state (runClaude's `current*` variables). */
export type ClaudeModeState = {
    permissionMode: PermissionMode | undefined;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    effort?: ClaudeEffort;
};

export type ResolveMessageModeContext = {
    sandboxEnabled: boolean;
    isAssistantVariant: boolean;
    /**
     * B-262 batch 2 (B4): the message's meta.permissionMode is a snapshot older
     * than the latest explicit switch (RPC / approval) — ignore it.
     */
    staleModeSnapshot: boolean;
};

export type ResolvedMessageMode = {
    /** The mode this message runs with. */
    mode: EnhancedMode;
    /** Sticky state after this message. */
    next: ClaudeModeState;
    /** Present when meta.permissionMode was applied: the caller must publish it. */
    publishPermissionMode?: PermissionMode | undefined;
    /** An `effort` value outside the SDK's accepted set was ignored. */
    ignoredEffort?: string;
};

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const has = (meta: MessageMeta | undefined, key: keyof MessageMeta): boolean =>
    !!meta && Object.prototype.hasOwnProperty.call(meta, key);

export function resolveMessageMode(
    current: ClaudeModeState,
    meta: MessageMeta | undefined,
    ctx: ResolveMessageModeContext,
): ResolvedMessageMode {
    const next: ClaudeModeState = { ...current };
    const result: Omit<ResolvedMessageMode, 'mode' | 'next'> = {};

    // Permission mode — pass through as-is; mapping happens at the SDK boundary.
    let permissionMode = current.permissionMode;
    if (!ctx.staleModeSnapshot && meta?.permissionMode) {
        permissionMode = resolveRemoteClaudePermissionMode(current.permissionMode, meta.permissionMode, ctx.sandboxEnabled);
        next.permissionMode = permissionMode;
        result.publishPermissionMode = permissionMode;
    }

    // null/'' on the wire = reset to the default (undefined).
    if (has(meta, 'model')) next.model = meta!.model || undefined;
    if (has(meta, 'customSystemPrompt')) next.customSystemPrompt = meta!.customSystemPrompt || undefined;
    if (has(meta, 'fallbackModel')) next.fallbackModel = meta!.fallbackModel || undefined;
    if (has(meta, 'appendSystemPrompt')) next.appendSystemPrompt = meta!.appendSystemPrompt || undefined;
    if (has(meta, 'allowedTools')) next.allowedTools = meta!.allowedTools || undefined;
    if (has(meta, 'disallowedTools')) {
        // B-063: a per-message override may deny MORE, never lift the
        // assistant's dispatcher denylist.
        next.disallowedTools = withAssistantDenylist(meta!.disallowedTools || undefined, ctx.isAssistantVariant);
    }

    // Effort — validated against the SDK's accepted set so a stale/garbage
    // value from the wire doesn't poison the session.
    if (has(meta, 'effort')) {
        const incoming = (meta as Record<string, unknown>).effort;
        if (incoming === null || incoming === undefined) {
            next.effort = undefined;
        } else if (typeof incoming === 'string' && VALID_EFFORTS.has(incoming)) {
            next.effort = incoming as ClaudeEffort;
        } else {
            result.ignoredEffort = String(incoming);
        }
    }

    return {
        ...result,
        next,
        mode: {
            permissionMode: permissionMode || 'default',
            model: next.model,
            fallbackModel: next.fallbackModel,
            customSystemPrompt: next.customSystemPrompt,
            appendSystemPrompt: next.appendSystemPrompt,
            allowedTools: next.allowedTools,
            disallowedTools: next.disallowedTools,
            effort: next.effort,
        },
    };
}
