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

it('shows a pi / Gemini / Claude turn failure and a process exit with its last words as errors (B-629)', () => {
    for (const message of [
        'pi error: Authentication required (401)',
        'Gemini error: quota exceeded. Quota resets in 3h20m35s.',
        'Claude error: model_not_found',
        'Process exited unexpectedly: pi process exited (code=3): FATAL ERROR: Reached heap limit',
    ]) {
        expect(presentServiceEvent(message)).toEqual({ kind: 'agent-error', text: message });
    }
    // The bare line keeps its fixed text and the restart action.
    expect(presentServiceEvent('Process exited unexpectedly')).toEqual({ kind: 'error', textKey: 'session.chat.processFailed' });
    // pi's own retry / compaction lines stay quiet notes.
    expect(presentServiceEvent('pi is retrying the model request (attempt 1/3, waiting 2s)')).toEqual({ kind: 'subtle', text: 'pi is retrying the model request (attempt 1/3, waiting 2s)' });
});

it('shows a Codex turn refusal as an error with its reason (B-487)', () => {
    const message = "Codex error: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.";
    expect(presentServiceEvent(message)).toEqual({ kind: 'agent-error', text: message });
    expect(presentServiceEvent('Codex error:')).toEqual({ kind: 'subtle', text: 'Codex error:' });
});
