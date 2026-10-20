import { describe, expect, it } from 'vitest';
import { piRestartNotice, readAcpReconnectEnv, sanitizeAgentSessionId } from './acpSessionResume';

describe('pi session resume (B-633)', () => {
    it('reads the daemon resume-in-place env, or nothing when it is incomplete', () => {
        expect(readAcpReconnectEnv({
            HAPPY_RECONNECT_SESSION_ID: 's1', HAPPY_RECONNECT_ENCRYPTION_KEY: 'k', HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
            HAPPY_RECONNECT_SEQ: '42', HAPPY_RECONNECT_METADATA_VERSION: '7', HAPPY_RECONNECT_AGENT_STATE_VERSION: 'x',
        })).toEqual({ sessionId: 's1', encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 42, metadataVersion: 7, agentStateVersion: 0 });
        expect(readAcpReconnectEnv({ HAPPY_RECONNECT_SESSION_ID: 's1', HAPPY_RECONNECT_ENCRYPTION_KEY: 'k', HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'other' })).toBeNull();
        expect(readAcpReconnectEnv({})).toBeNull();
    });

    it('one line per outcome: reopened, could not reopen (why), or no attempt', () => {
        expect(piRestartNotice('pi', 'agent-exit', { resumed: 'loaded' })).toBe('pi was restarted after its process exited and reopened the earlier conversation.');
        expect(piRestartNotice('pi', 'agent-exit', { resumed: 'fresh', loadFailure: 'Unknown sessionId:\n abc' }))
            .toBe('pi was restarted after its process exited but could not reopen the earlier conversation (Unknown sessionId: abc); it does not remember it (the transcript here is kept).');
        expect(piRestartNotice('pi', 'resume', { resumed: 'fresh' })).toBe('pi was started again but could not reopen the earlier conversation; it does not remember it (the transcript here is kept).');
        expect(piRestartNotice('pi', 'agent-exit', {})).toBe('pi was restarted after its process exited; it does not remember the earlier conversation (the transcript here is kept).');
    });

    it('a resume id never parses as a flag', () => {
        expect(sanitizeAgentSessionId('3f2a1b2c-0000-4000-8000-000000000000')).toBe('3f2a1b2c-0000-4000-8000-000000000000');
        expect(sanitizeAgentSessionId('--model')).toBeNull();
        expect(sanitizeAgentSessionId('')).toBeNull();
        expect(sanitizeAgentSessionId(undefined)).toBeNull();
    });
});
