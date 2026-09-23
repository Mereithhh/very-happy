import { describe, expect, it } from 'vitest';
import { presentServiceEvent } from './serviceEvent';

describe('presentServiceEvent', () => {
    it('distinguishes a deliberate stop from a failure', () => {
        expect(presentServiceEvent('Aborted by user')).toEqual({ kind: 'stopped', textKey: 'session.chat.stoppedByYou' });
        expect(presentServiceEvent('Process exited unexpectedly')).toEqual({ kind: 'error', textKey: 'session.chat.processFailed' });
    });

    it('keeps unknown service notes intact', () => {
        expect(presentServiceEvent('Context was reset')).toEqual({ kind: 'subtle', text: 'Context was reset' });
    });

    it('hides internal EDE-only lifecycle events, including the SDK wrapper', () => {
        const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';
        expect(presentServiceEvent(diagnostic)).toEqual({ kind: 'hidden' });
        expect(presentServiceEvent(`Claude Code returned an error result: ${diagnostic}`))
            .toEqual({ kind: 'hidden' });
    });

    // B-297: old CLIs never send `kind: 'claude-auth-failed'`; the raw text is
    // the only signal, and it used to render as an unactionable grey mono line.
    it('recognises a Claude auth failure from the raw text alone', () => {
        expect(presentServiceEvent('authentication_failed')).toEqual({ kind: 'claude-auth' });
        expect(presentServiceEvent('Claude Code returned an error result: authentication_failed'))
            .toEqual({ kind: 'claude-auth' });
        expect(presentServiceEvent('Failed to authenticate: OAuth session expired and could not be refreshed'))
            .toEqual({ kind: 'claude-auth' });
        expect(presentServiceEvent('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed'))
            .toEqual({ kind: 'claude-auth' });
    });

    it('does not turn an unrelated note that names the error into an auth card', () => {
        expect(presentServiceEvent('retrying after authentication_failed earlier'))
            .toEqual({ kind: 'subtle', text: 'retrying after authentication_failed earlier' });
    });

    it('removes EDE diagnostics but preserves an adjacent real failure', () => {
        expect(presentServiceEvent(
            '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use; permission bridge crashed',
        )).toEqual({ kind: 'subtle', text: 'permission bridge crashed' });
    });
});

it('shows a Codex turn refusal as an error with its reason (B-487)', () => {
    const message = "Codex error: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.";
    expect(presentServiceEvent(message)).toEqual({ kind: 'agent-error', text: message });
    expect(presentServiceEvent('Codex error:')).toEqual({ kind: 'subtle', text: 'Codex error:' });
});
