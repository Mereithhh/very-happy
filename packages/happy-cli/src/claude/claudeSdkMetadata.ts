import type { Metadata } from '@/api/types';
import { CLAUDE_ATTACHMENT_KINDS } from './utils/attachmentContent';
import type { ClaudeRunFacts } from './claudeRunFacts';

export type ClaudeSdkMetadata = {
    models?: Metadata['models'];
    tools?: string[];
    slashCommands?: string[];
    mcpServers?: { name: string; status: string }[];
    skills?: string[];
    model?: string;
    modelIsDefault: boolean;
    /** Effective permission mode Claude Code reports in system/init (B-262 batch 2). */
    permissionMode?: string;
};

export function applyClaudeSdkMetadata(current: Metadata, update: ClaudeSdkMetadata): Metadata {
    return {
        ...current,
        ...(update.models ? { models: update.models } : {}),
        tools: update.tools,
        slashCommands: update.slashCommands,
        mcpServers: update.mcpServers,
        skills: update.skills,
        attachmentKinds: [...CLAUDE_ATTACHMENT_KINDS],
        queueCancellation: true,
        // The model Claude Code reports it is ACTUALLY running. system/init is
        // re-emitted at every turn boundary (verified against the pinned SDK,
        // 2026-09-03), including after a live setModel, so this is the web's
        // only ground truth for "did my switch take effect" — the picker
        // otherwise renders nothing but the client's own optimistic intent.
        ...(update.model ? { currentModelCode: update.model } : {}),
        ...(update.modelIsDefault && update.model
            ? { defaultModelCode: update.model }
            : {}),
    };
}

/**
 * B-849b: publish what Claude Code says it runs. Unchanged facts return the
 * same object so the client skips a no-op metadata write. `currentThoughtLevelCode`
 * is dropped when no effort is sent (a model without effort support).
 */
export function applyClaudeRunFacts(current: Metadata, facts: ClaudeRunFacts): Metadata {
    let next = current;
    if (facts.configuredModel !== undefined && current.configuredModel !== facts.configuredModel) {
        next = { ...next, configuredModel: facts.configuredModel };
    }
    if (facts.effort !== undefined) {
        if (facts.effort === null) {
            if (next.currentThoughtLevelCode !== undefined) {
                const { currentThoughtLevelCode: _dropped, ...rest } = next;
                next = rest as Metadata;
            }
        } else if (next.currentThoughtLevelCode !== facts.effort) {
            next = { ...next, currentThoughtLevelCode: facts.effort };
        }
    }
    return next;
}
