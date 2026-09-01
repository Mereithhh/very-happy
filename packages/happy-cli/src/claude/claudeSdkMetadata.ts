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
        ...(update.modelIsDefault && update.model
            ? { defaultModelCode: update.model }
            : {}),
    };
}
