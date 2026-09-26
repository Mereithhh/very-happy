import { describe, expect, it } from 'vitest';
import { clientTag, isOwnerAuthoredMessage, linkedSessionIds, MAX_LINKED_SESSIONS } from './attentionLifecycle';

describe('B-508 attention lifecycle (pure rules)', () => {
    it('treats web / app / relay-persisted / terminal-send messages as the owner speaking', () => {
        expect(isOwnerAuthoredMessage({ localId: 'b1f3c6a2-6a2d-4a0f-9f3e-2f5a4c1d8e90', client: 'web/1.2.3' })).toBe(true);
        // The wrapper tag counts only with the relay-client origin: its own agent output uses the same tag without it.
        expect(isOwnerAuthoredMessage({ localId: 'b1f3c6a2-6a2d-4a0f-9f3e-2f5a4c1d8e90', client: 'cli-coding-session/0.2.158', origin: 'relay-client' })).toBe(true);
        expect(isOwnerAuthoredMessage({ localId: 'b1f3c6a2-6a2d-4a0f-9f3e-2f5a4c1d8e90', client: 'cli-coding-session/0.2.157' })).toBe(false);
        expect(isOwnerAuthoredMessage({ localId: 'any', client: 'cli-coding-session/0.2.158', origin: 'something-else' })).toBe(false);
        expect(isOwnerAuthoredMessage({ localId: 'b1f3c6a2-6a2d-4a0f-9f3e-2f5a4c1d8e90', client: 'cli-send/0.2.157' })).toBe(true);
        expect(isOwnerAuthoredMessage({ localId: null, client: 'ios/1.0.0' })).toBe(true);
        expect(isOwnerAuthoredMessage({ localId: 'x', client: undefined, connectionType: 'user-scoped' })).toBe(true);
    });
    it('never counts automated senders: wrapper socket, stamped localIds, automated client tags', () => {
        expect(isOwnerAuthoredMessage({ localId: null, connectionType: 'session-scoped' })).toBe(false);
        for (const localId of ['automation-r1', 'teams-initial-op1', 'teams-message-m1-2', 'remote-send-abc', 'session-message-1a2b3c4d', 'edit-conflict-n1-s2']) {
            expect(isOwnerAuthoredMessage({ localId, client: 'web/1.0.0' }), localId).toBe(false);
        }
        for (const client of ['automation/0.2.157', 'teams/0.2.157', 'cli-spawn/0.2.157', 'assistant-mcp/0.2.157', 'session-message/0.2.157', 'daemon-auto/0.2.157', 'Automation/1']) {
            expect(isOwnerAuthoredMessage({ localId: 'any', client }), client).toBe(false);
        }
    });
    it('parses the client tag before the slash, case-insensitively', () => {
        expect(clientTag('web/1.2.3')).toBe('web');
        expect(clientTag('CLI-Send')).toBe('cli-send');
        expect(clientTag('')).toBeNull();
        expect(clientTag(undefined)).toBeNull();
    });
    it('links a run to its own session plus the sessions its JSON payload names', () => {
        expect(linkedSessionIds({ sessionId: 'cmuisjr3z1dd8qk2k5flkij3i', payload: null })).toEqual(['cmuisjr3z1dd8qk2k5flkij3i']);
        const payload = JSON.stringify({ batchId: 'b', sessions: [{ id: 'cmuhngqum0dy8qk2kubh1q7j3', url: 'https://x/session/cmuhngqum0dy8qk2kubh1q7j3' }, 'cmuh2tsk4008xpc2kul7s60rk', { nope: 1 }, 'bad id'], sessionId: 'cmuh0hcm2015zlx2km1tjarfc', sessionIds: ['cmuh0hcm2015zlx2km1tjarfc'] });
        expect(linkedSessionIds({ sessionId: 'cmuisjr3z1dd8qk2k5flkij3i', payload })).toEqual(['cmuisjr3z1dd8qk2k5flkij3i', 'cmuhngqum0dy8qk2kubh1q7j3', 'cmuh2tsk4008xpc2kul7s60rk', 'cmuh0hcm2015zlx2km1tjarfc']);
    });
    it('ignores non-JSON, oversized and malformed payloads and caps the list', () => {
        expect(linkedSessionIds({ sessionId: null, payload: 'plain text with cmuhngqum0dy8qk2kubh1q7j3' })).toEqual([]);
        expect(linkedSessionIds({ sessionId: null, payload: '{not json' })).toEqual([]);
        expect(linkedSessionIds({ sessionId: null, payload: '[1,2]' })).toEqual([]);
        expect(linkedSessionIds({ sessionId: null, payload: '{"sessions":' + 'x'.repeat(70_000) + '}' })).toEqual([]);
        const many = JSON.stringify({ sessions: Array.from({ length: MAX_LINKED_SESSIONS + 10 }, (_, i) => `session${String(i).padStart(4, '0')}`) });
        expect(linkedSessionIds({ sessionId: null, payload: many })).toHaveLength(MAX_LINKED_SESSIONS);
    });
});
