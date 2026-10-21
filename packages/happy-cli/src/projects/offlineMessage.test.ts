import { describe, expect, it, vi } from 'vitest';
import { sendPeerMessage, OFFLINE_STORED_NOTE, type PeerToolContext } from '@/sessions/peerTools';

/**
 * B-646: a session_message to a session that is not running is stored as a
 * project offline message when both are in the same project (was: refused);
 * otherwise the old refusal stands. Read at the recipient's next turn by the
 * B-645 injector (prefix or digest), which also marks it delivered.
 */
const self = () => ({ sessionId: 'me', title: 'me', flavor: 'claude', cwd: '/repo' });
const persisted = { target: { metadata: { machineId: 'm' } } } as any;

describe('session_message offline fallback (B-646)', () => {
    it('not running locally + same project → stored, with the next-turn note', async () => {
        const storeOffline = vi.fn(async () => ({ projectId: 'p', messageId: 'abcdef123456' }));
        const ctx: PeerToolContext = { self, readPersisted: () => persisted, listPeers: async () => [], storeOffline, sentTo: new Map() };
        const out = await sendPeerMessage(ctx, { to: 'target', body: '  schema changed  ' });
        expect(storeOffline).toHaveBeenCalledWith({ from: 'me', to: 'target', body: 'schema changed' });
        expect(out).toMatchObject({ delivered: false, stored: true, status: 'offline-stored', messageId: 'abcdef12', note: OFFLINE_STORED_NOTE });
        expect(ctx.sentTo!.get('target')).toHaveLength(1);
    });
    it('not running + no shared project (or old server) → the original refusal', async () => {
        const ctx: PeerToolContext = { self, readPersisted: () => persisted, listPeers: async () => [], storeOffline: async () => null };
        await expect(sendPeerMessage(ctx, { to: 'target', body: 'x' })).rejects.toThrow(/not running on this machine/);
    });
    it('another machine that cannot be reached → stored when in the same project, else its own error', async () => {
        const remote = vi.fn(async () => { throw new Error('machine offline'); });
        const stored = await sendPeerMessage({ self, readPersisted: () => ({}), remoteMessage: remote, storeOffline: async () => ({ projectId: 'p', messageId: 'id-1' }) }, { to: 'far', body: 'hi' });
        expect(stored).toMatchObject({ stored: true, status: 'offline-stored' });
        await expect(sendPeerMessage({ self, readPersisted: () => ({}), remoteMessage: remote, storeOffline: async () => null }, { to: 'far', body: 'hi' })).rejects.toThrow('machine offline');
    });
    it('the reply-loop budget still applies to stored messages', async () => {
        const sentTo = new Map<string, number[]>([['target', Array.from({ length: 8 }, () => 1)]]);
        const ctx: PeerToolContext = { self, readPersisted: () => persisted, listPeers: async () => [], storeOffline: async () => ({ projectId: 'p', messageId: 'x' }), sentTo, now: () => 2 };
        await expect(sendPeerMessage(ctx, { to: 'target', body: 'again' })).rejects.toThrow(/reply loop/);
    });
    it('a live target is delivered as before (no store)', async () => {
        const storeOffline = vi.fn();
        const deliver = vi.fn(async () => ({ sessionId: 'target', delivered: true, stored: true, resumed: false, status: 'live' as const }));
        const out = await sendPeerMessage({ self, readPersisted: () => persisted, listPeers: async () => [{ sessionId: 'target', kind: 'session' } as any], deliver, storeOffline }, { to: 'target', body: 'hi' });
        expect(out).toMatchObject({ delivered: true, status: 'live' });
        expect(storeOffline).not.toHaveBeenCalled();
    });
});
