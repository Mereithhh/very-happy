export type ServiceEventPresentation =
    | { kind: 'hidden' }
    | { kind: 'stopped'; textKey: 'session.chat.stoppedByYou' }
    | { kind: 'error'; textKey: 'session.chat.processFailed' }
    | { kind: 'claude-auth' }
    /** B-487: the agent refused the turn and said why (e.g. Codex's backend
     *  400 for a model the sign-in cannot use) — shown as an error, verbatim. */
    | { kind: 'agent-error'; text: string }
    | { kind: 'subtle'; text: string };

/**
 * B-297: version-independent detection of a Claude Code auth failure.
 *
 * CLI ≥ v0.2.97 tags the failure structurally (`kind: 'claude-auth-failed'`,
 * see B-276), but iron rule 14 says an already-running wrapper never picks up a
 * daemon upgrade — and users on an older CLI never get the tag at all. On those
 * versions the only thing that reaches the web is the raw SDK text as a plain
 * service event, which used to render as an unactionable grey mono line
 * ("authentication_failed") next to "The agent process exited unexpectedly".
 * Matching the text here gives every CLI version the same actionable card.
 *
 * The pattern is deliberately anchored/narrow: this function only ever sees
 * service events (never assistant prose), but `authentication_failed` must not
 * match a longer sentence that merely mentions it.
 */
/** The reason-less line a failed turn-end becomes (reducer fallback). */
export const GENERIC_TURN_FAILURE = /^(claude )?turn failed$/i;

const CLAUDE_AUTH_FAILURE = /^authentication_failed$|failed to authenticate|oauth session expired/i;

export function presentServiceEvent(message: string): ServiceEventPresentation {
    const trimmed = message.trim();
    const sdkErrorPrefix = 'claude code returned an error result:';
    const payload = trimmed.toLowerCase().startsWith(sdkErrorPrefix)
        ? trimmed.slice(sdkErrorPrefix.length).trim()
        : trimmed;
    const entries = payload.split(/[;\n]+/).map((entry) => entry.trim()).filter(Boolean);
    const visibleEntries = entries.filter((entry) => !entry.startsWith('[ede_diagnostic]'));
    if (visibleEntries.length === 0 && visibleEntries.length !== entries.length) {
        return { kind: 'hidden' };
    }
    const visibleMessage = visibleEntries.length !== entries.length
        ? visibleEntries.join('\n')
        : trimmed;
    const normalized = visibleMessage.toLowerCase();
    if (normalized === 'aborted by user' || normalized === 'turn aborted') {
        return { kind: 'stopped', textKey: 'session.chat.stoppedByYou' };
    }
    if (normalized === 'process exited unexpectedly') {
        return { kind: 'error', textKey: 'session.chat.processFailed' };
    }
    if (visibleEntries.some((entry) => CLAUDE_AUTH_FAILURE.test(entry))) {
        return { kind: 'claude-auth' };
    }
    if (/^codex error:\s*\S/i.test(visibleMessage) || GENERIC_TURN_FAILURE.test(visibleMessage)) {
        return { kind: 'agent-error', text: visibleMessage };
    }
    return { kind: 'subtle', text: visibleMessage };
}
