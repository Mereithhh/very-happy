import type { SDKResultMessage } from '../sdk/types';

/**
 * Why a remote-mode SDK Query sometimes has to be thrown away after a turn.
 *
 * Claude Code caches a failed OAuth refresh for the lifetime of its process:
 * once a turn ends with `authentication_failed`, every later prompt fed into
 * the same long-lived Query fails in ~20ms without touching the network
 * ("Failed to authenticate: OAuth session expired and could not be
 * refreshed") — even after the credentials on disk are valid again.
 * 2026-09-01 (mac-office): one refresh failure during a network flap wedged a
 * web session this way until its wrapper was restarted, while a terminal
 * `claude` and every freshly spawned one-shot worked with the same
 * ~/.claude/.credentials.json.
 *
 * Ending the Query after such a result makes the next queued message spawn a
 * fresh process that re-reads the credentials, instead of replaying a stale
 * verdict forever. Nothing is retried automatically: a genuinely expired login
 * fails again on the next message, with the same visible error.
 */
export type QueryRecycleReason = 'authentication_failed';

const AUTH_FAILURE_RESULT_TEXT = /Failed to authenticate|OAuth session expired/i;

export const QUERY_RECYCLE_NOTICE: Record<QueryRecycleReason, string> = {
    authentication_failed:
        '⚠️ Claude Code could not refresh its OAuth session. This agent process was ended so your next message '
        + 'starts a fresh one that re-reads the credentials on this machine; if it fails again, run `claude` '
        + 'on the machine to log in again.',
};

/**
 * Decide whether the Query that produced `result` must be ended instead of
 * being fed the next message.
 *
 * @param lastAssistantError `error` of the most recent assistant frame in this
 *   turn (SDKAssistantMessage.error, e.g. 'authentication_failed'); undefined
 *   when the turn produced no flagged frame or the producer predates the field.
 */
export function queryRecycleReason(
    result: Pick<SDKResultMessage, 'subtype'> & { is_error?: boolean; result?: string },
    lastAssistantError: string | undefined,
): QueryRecycleReason | null {
    if (lastAssistantError === 'authentication_failed') {
        return 'authentication_failed';
    }
    // Older producers / synthetic frames: the result text is the only signal.
    if (result.is_error && typeof result.result === 'string' && AUTH_FAILURE_RESULT_TEXT.test(result.result)) {
        return 'authentication_failed';
    }
    return null;
}
