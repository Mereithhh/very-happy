import { BUILTIN_TODO_DISCOVERY } from '@/modules/todo/skill';
import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { hashObject } from '@/utils/deterministicJson';

import type { ReasoningEffort } from './codexAppServerTypes';

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** B-844d: this message reset the model (`meta.model === null`) — the turn names the machine default. */
    modelReset?: boolean;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        modelReset: mode.modelReset,
        appendSystemPrompt: mode.appendSystemPrompt,
        effort: mode.effort,
    });
}

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt'>;
    includeAppendSystemPrompt: boolean;
    includeTitleInstruction: boolean;
}): string {
    const parts: string[] = [];

    if (opts.includeAppendSystemPrompt && opts.mode.appendSystemPrompt) {
        parts.push(opts.mode.appendSystemPrompt);
    }

    parts.push(opts.message);

    if (opts.includeTitleInstruction) {
        parts.push(CHANGE_TITLE_INSTRUCTION);
        parts.push(BUILTIN_TODO_DISCOVERY);
    }

    return parts.join('\n\n');
}
