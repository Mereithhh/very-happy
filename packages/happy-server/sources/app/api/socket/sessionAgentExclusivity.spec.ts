import { describe, expect, it, vi } from 'vitest';
import {
    agentPeerOf,
    arbitrateSessionAgent,
    decideAgentAdmission,
    parseAgentIdentity,
    SESSION_SUPERSEDED_EVENT,
    type AgentPeer,
} from './sessionAgentExclusivity';

const agent = (id: string, startedAt: number | null, instance = `inst-${id}`): AgentPeer => ({
    id,
    identity: startedAt === null ? null : { instance, startedAt },
    happyClient: 'cli-coding-session/0.2.196',
});

describe('B-864 decideAgentAdmission — newest wrapper process wins', () => {
    it('a newer process evicts the older one and every legacy wrapper', () => {
        const verdict = decideAgentAdmission(agent('new', 2_000), [agent('old', 1_000), agent('legacy', null)]);
        expect(verdict).toEqual({ admit: true, evict: [agent('old', 1_000), agent('legacy', null)] });
    });

    it('a stale process reconnecting after the newer one is refused — no ping-pong', () => {
        const verdict = decideAgentAdmission(agent('old-again', 1_000, 'inst-old'), [agent('new', 2_000)]);
        expect(verdict).toEqual({ admit: false, holder: agent('new', 2_000) });
    });

    it('the same process (release handover candidate / reconnect) never evicts itself', () => {
        const verdict = decideAgentAdmission(agent('candidate', 1_000, 'inst-A'), [agent('previous', 1_000, 'inst-A')]);
        expect(verdict).toEqual({ admit: true, evict: [] });
    });

    it('equal start times break on the instance id, identically from both sides', () => {
        const a = agent('a', 1_000, 'aaa');
        const b = agent('b', 1_000, 'bbb');
        expect(decideAgentAdmission(a, [b])).toEqual({ admit: false, holder: b });
        expect(decideAgentAdmission(b, [a])).toEqual({ admit: true, evict: [a] });
    });

    it('legacy wrappers: refused beside an identified one, unchanged among themselves', () => {
        expect(decideAgentAdmission(agent('legacy', null), [agent('new', 2_000)])).toEqual({ admit: false, holder: agent('new', 2_000) });
        expect(decideAgentAdmission(agent('legacy2', null), [agent('legacy1', null)])).toEqual({ admit: true, evict: [] });
    });

    it('the holder named on a refusal is the newest peer', () => {
        const verdict = decideAgentAdmission(agent('stale', 1_000), [agent('mid', 2_000), agent('newest', 3_000)]);
        expect(verdict).toEqual({ admit: false, holder: agent('newest', 3_000) });
    });
});

describe('B-864 identity parsing', () => {
    it('accepts only a bounded instance id and a positive integer start time', () => {
        expect(parseAgentIdentity({ agentInstance: 'x', agentStartedAt: 5 })).toEqual({ instance: 'x', startedAt: 5 });
        expect(parseAgentIdentity({ agentInstance: '', agentStartedAt: 5 })).toBeNull();
        expect(parseAgentIdentity({ agentInstance: 'x'.repeat(129), agentStartedAt: 5 })).toBeNull();
        expect(parseAgentIdentity({ agentInstance: 'x', agentStartedAt: 1.5 })).toBeNull();
        expect(parseAgentIdentity({ agentInstance: 'x', agentStartedAt: '5' })).toBeNull();
        expect(parseAgentIdentity(undefined)).toBeNull();
    });

    it('only session-scoped wrappers are agents; other session sockets are never touched', () => {
        expect(agentPeerOf({ id: 's', data: { clientType: 'session-scoped', happyClient: 'cli-coding-session/0.2.150' } })).toEqual({ id: 's', identity: null, happyClient: 'cli-coding-session/0.2.150' });
        expect(agentPeerOf({ id: 's', data: { clientType: 'session-scoped' } })).toBeNull();                 // happy-agent prototype
        expect(agentPeerOf({ id: 's', data: { clientType: 'user-scoped', agentInstance: 'x', agentStartedAt: 1 } })).toBeNull();
        expect(agentPeerOf({ id: 's', data: { clientType: 'session-scoped', agentInstance: 'x', agentStartedAt: 1 } })?.identity).toEqual({ instance: 'x', startedAt: 1 });
    });
});

describe('B-864 arbitrateSessionAgent', () => {
    const socket = (id: string, data: Record<string, unknown>) => ({ id, data, emit: vi.fn(), disconnect: vi.fn() });

    it('tells each evicted wrapper who superseded it, then disconnects it', async () => {
        const old = socket('old', { clientType: 'session-scoped', agentInstance: 'o', agentStartedAt: 1_000, happyClient: 'cli-coding-session/0.2.195' });
        const web = socket('web', { clientType: 'user-scoped' });
        const onEvict = vi.fn();
        const result = await arbitrateSessionAgent({
            self: agent('new', 2_000),
            sessionId: 's1',
            fetchPeers: async () => [old, web],
            onEvict,
        });
        expect(result.admitted).toBe(true);
        expect(old.emit).toHaveBeenCalledWith(SESSION_SUPERSEDED_EVENT, { sessionId: 's1', by: { startedAt: 2_000, happyClient: 'cli-coding-session/0.2.196' } });
        expect(old.disconnect).toHaveBeenCalledWith(true);
        expect(old.emit.mock.invocationCallOrder[0]).toBeLessThan(old.disconnect.mock.invocationCallOrder[0]);
        expect(web.disconnect).not.toHaveBeenCalled();
        expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
    });

    it('fails open when the room lookup fails (connectivity first)', async () => {
        await expect(arbitrateSessionAgent({
            self: agent('new', 2_000), sessionId: 's1', fetchPeers: async () => { throw new Error('timeout'); },
        })).resolves.toEqual({ admitted: true, evicted: [] });
    });
});
