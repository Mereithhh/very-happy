import type { Metadata } from '@/api/types';
import { CLAUDE_ATTACHMENT_KINDS } from './utils/attachmentContent';

export type ClaudeSdkMetadata = {
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
