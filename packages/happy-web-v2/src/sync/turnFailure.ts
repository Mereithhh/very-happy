/**
 * B-913 — "this turn ended on a model / upstream API error", web side, pure.
 *
 * The wrapper writes `agentState.turnFailure` when a turn fails that way and
 * clears it when the next turn starts or succeeds (CLI `claude/turnFailure.ts`,
 * `codex/codexTurnFailure.ts`). Only wrappers that declare
 * TURN_FAILURE_CAPABILITY write it (AGENTS #14: capabilities, not versions);
 * an old wrapper never has one, so nothing changes for it.
 */
import { readTurnFailure, TURN_FAILURE_CAPABILITY, type TurnFailure } from '@slopus/happy-wire';
import type { Message, UserTextMessage } from './typesMessage';

export type TurnFailureInput = {
    metadata?: { capabilities?: readonly string[] | null } | null;
    agentState?: { turnFailure?: unknown } | null;
    /** a turn is running again — the failure is history */
    thinking?: boolean;
    archivedAt?: number | null;
};

/** The failure to show for this session now, or null. */
export function sessionTurnFailure(session: TurnFailureInput | null | undefined): TurnFailure | null {
    if (!session || session.archivedAt != null || session.thinking === true) return null;
    if (session.metadata?.capabilities?.includes(TURN_FAILURE_CAPABILITY) !== true) return null;
    return readTurnFailure(session.agentState?.turnFailure);
}

/** What 「重试」 sends again: the newest user message in the loaded transcript (newest-first or chronological). */
export function lastUserMessage(messages: readonly Message[], order: 'newest-first' | 'chronological'): UserTextMessage | null {
    const pick = (m: Message): m is UserTextMessage => m.kind === 'user-text' && typeof m.text === 'string' && m.text.trim().length > 0;
    if (order === 'newest-first') {
        for (const m of messages) if (pick(m)) return m;
        return null;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) if (pick(messages[i])) return messages[i] as UserTextMessage;
    return null;
}
