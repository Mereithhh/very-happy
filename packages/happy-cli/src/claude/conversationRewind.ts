/**
 * B-528: `conversation-rewind` session RPC — edit or delete one of the user's
 * prompts IN PLACE. The wrapper stops a running turn, writes a rewound copy of
 * the Claude transcript (utils/claudeTranscriptRewind.ts), points the session
 * at it and relaunches the query silently; the next prompt resumes from the
 * rewound history. The web hides the dropped messages with its own tombstone.
 */

import { ConversationRewindError, rewindClaudeTranscript, type ConversationRewindAction } from './utils/claudeTranscriptRewind';
import { ForkSourceMissingError } from './utils/claudeSessionFork';

export type ConversationRewindResult =
    | { ok: true; action: ConversationRewindAction; freshConversation: boolean }
    | { ok: false; code: 'invalid' | 'busy' | 'running' | 'no-conversation' | 'not-found' | 'ambiguous' | 'unsafe'; error: string };

export type ConversationRewindDeps = {
    claudeSessionId: () => string | null;
    projectDir: () => string;
    isThinking: () => boolean;
    /** Stop the running turn (the Stop button's path). */
    stopTurn: () => Promise<void>;
    /** Resolves true once the turn is idle, false after `ms`. */
    waitIdle: (ms: number) => Promise<boolean>;
    /** Other transcript uuids this source id may live under (batched prompts). */
    aliases: (sourceId: string) => string[];
    /** Point the session at `claudeSessionId` (null = fresh) and relaunch without a user-visible abort. */
    switchConversation: (claudeSessionId: string | null) => Promise<void>;
    rewrite?: typeof rewindClaudeTranscript;
};

const STOP_WAIT_MS = 8000;

export function createConversationRewind(deps: ConversationRewindDeps) {
    let inFlight = false;
    const rewrite = deps.rewrite ?? rewindClaudeTranscript;
    return async (input: unknown): Promise<ConversationRewindResult> => {
        const request = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
        const action = request.action;
        const sourceId = typeof request.sourceId === 'string' && request.sourceId.length > 0 && request.sourceId.length <= 200 ? request.sourceId : undefined;
        const text = typeof request.text === 'string' && request.text.length <= 200_000 ? request.text : undefined;
        if ((action !== 'edit' && action !== 'delete') || (!sourceId && !text?.trim())) {
            return { ok: false, code: 'invalid', error: 'Invalid rewind request' };
        }
        if (inFlight) return { ok: false, code: 'busy', error: 'Another edit is still being applied' };
        inFlight = true;
        try {
            if (deps.isThinking()) {
                await deps.stopTurn();
                if (!await deps.waitIdle(STOP_WAIT_MS)) {
                    return { ok: false, code: 'running', error: 'The agent did not stop; try again after it finishes' };
                }
            }
            const current = deps.claudeSessionId();
            if (!current) return { ok: false, code: 'no-conversation', error: 'The agent has no conversation to change yet' };
            const uuids = sourceId ? [sourceId, ...deps.aliases(sourceId)] : [];
            const next = await rewrite(deps.projectDir(), current, action, { uuids, text });
            await deps.switchConversation(next);
            return { ok: true, action, freshConversation: next === null };
        } catch (error) {
            if (error instanceof ConversationRewindError) return { ok: false, code: error.code, error: error.message };
            if (error instanceof ForkSourceMissingError) return { ok: false, code: 'no-conversation', error: 'The agent conversation file is missing on this machine' };
            throw error;
        } finally {
            inFlight = false;
        }
    };
}
