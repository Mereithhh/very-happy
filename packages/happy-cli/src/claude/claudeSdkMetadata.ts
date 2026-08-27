import type { Metadata } from '@/api/types';
import { CLAUDE_ATTACHMENT_KINDS } from './utils/attachmentContent';

export type ClaudeSdkMetadata = {
    tools?: string[];
    slashCommands?: string[];
    mcpServers?: { name: string; status: string }[];
    skills?: string[];
    model?: string;
    modelIsDefault: boolean;
};

export function applyClaudeSdkMetadata(current: Metadata, update: ClaudeSdkMetadata): Metadata {
    return {
        ...current,
        tools: update.tools,
        slashCommands: update.slashCommands,
        mcpServers: update.mcpServers,
        skills: update.skills,
        attachmentKinds: [...CLAUDE_ATTACHMENT_KINDS],
        ...(update.modelIsDefault && update.model
            ? { defaultModelCode: update.model }
            : {}),
    };
}
