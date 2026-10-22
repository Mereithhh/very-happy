import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AttentionItem, AttentionItemPost } from '@slopus/happy-wire';

/**
 * B-766 C-1 through the real MCP transport: `owner_board_*` appear only for a
 * team lead on a server that serves the board, `owner-board-v1` is advertised,
 * and the session client's taps drive the owner-question fallback.
 */
const state = vi.hoisted(() => ({ supported: true, lead: true, calls: [] as Array<{ op: string; id?: string; body?: unknown }> }));

vi.mock('@/attention/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./client')>();
    let seq = 0;
    const item = (over: Partial<AttentionItem>): AttentionItem => ({
        id: `item-${++seq}`, sessionId: 'lead-session', teamId: null, projectId: null, source: 'lead', kind: 'report', key: null, title: 't', bodyMd: null,
        options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: false, state: 'open', ownerChoice: null,
        ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 0, updatedAt: 0, resolvedAt: null, pushedAt: null, version: 0, ...over,
    });
    const client = {
        isDisabled: () => !state.supported,
        probe: async () => state.supported,
        post: async (body: AttentionItemPost) => { state.calls.push({ op: 'post', body }); return { item: item({ kind: body.kind, title: body.title }), created: true }; },
        patch: async (id: string, body: unknown) => { state.calls.push({ op: 'patch', id, body }); return { item: item({ id, state: 'open' }) }; },
        resolve: async (id: string, body: unknown) => { state.calls.push({ op: 'resolve', id, body }); return { item: item({ id, state: 'answered' }) }; },
        list: async () => ({ items: [] }),
    };
    return { ...actual, sharedAttentionClient: () => client };
});
vi.mock('@/attention/leadBoard', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./leadBoard')>();
    return { ...actual, resolveTeamLead: async () => state.lead };
});

const { startHappyServer } = await import('@/claude/utils/startHappyServer');

function fakeSession() {
    const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
    let metadata: Record<string, any> = { machineId: 'm1' };
    emitter.sessionId = 'lead-session';
    emitter.getMetadata = () => metadata;
    emitter.updateMetadata = (fn: (m: Record<string, any>) => Record<string, any>) => { metadata = fn(metadata); };
    emitter.rpcHandlerManager = { registerHandler: () => {}, unregisterHandler: () => {} };
    return emitter;
}

describe('owner board in startHappyServer', () => {
    let happy: Awaited<ReturnType<typeof startHappyServer>> | undefined;
    let mcp: Client | undefined;
    afterEach(async () => {
        await mcp?.close(); mcp = undefined;
        happy?.stop(); happy = undefined;
        state.calls = []; state.supported = true; state.lead = true;
    });

    async function connect(session: ReturnType<typeof fakeSession>) {
        happy = await startHappyServer(session as any);
        mcp = new Client({ name: 'board-probe', version: '1' });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(happy.url)));
        return (await mcp.listTools()).tools.map(t => t.name);
    }

    it('exposes the four tools to a lead on a board server and advertises owner-board-v1', async () => {
        const session = fakeSession();
        const names = await connect(session);
        expect(names).toEqual(expect.arrayContaining(['owner_board_post', 'owner_board_update', 'owner_board_resolve', 'owner_board_list']));
        expect(session.getMetadata().capabilities).toContain('owner-board-v1');
        expect(happy!.toolNames).toEqual(expect.arrayContaining(['owner_board_post', 'request_human']));

        const refused = await mcp!.callTool({ name: 'owner_board_post', arguments: { kind: 'decision', title: 'Pick', request_id: 'r0' } });
        expect(refused.isError).toBe(true);
        expect(state.calls).toEqual([]);
        const posted = await mcp!.callTool({ name: 'owner_board_post', arguments: { kind: 'report', title: 'Merged', request_id: 'r1' } });
        expect(posted.isError).toBe(false);
        expect(JSON.parse((posted.content as any)[0].text)).toMatchObject({ created: true });
        expect(state.calls[0].body).toMatchObject({ sessionId: 'lead-session', source: 'lead', kind: 'report', title: 'Merged', requestId: 'r1' });
    });

    for (const [label, supported, lead] of [['a member session', true, false], ['a server without the board', false, true]] as const) {
        it(`hides the tools for ${label}`, async () => {
            state.supported = supported; state.lead = lead;
            const session = fakeSession();
            const names = await connect(session);
            expect(names.some(n => n.startsWith('owner_board_'))).toBe(false);
            expect(names).toContain('request_human');
            expect(Boolean(session.getMetadata().capabilities?.includes('owner-board-v1'))).toBe(supported);
        });
    }

    it('turns a routed owner message into a question and settles it from the Claude reply at turn end', async () => {
        const session = fakeSession();
        await connect(session);
        session.emit('user-message-routed', { localId: 'm1', message: { content: { text: 'Who writes the notes?' }, meta: { sentFrom: 'web' } } });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(state.calls[0]).toMatchObject({ op: 'post', body: { source: 'owner', kind: 'question', anchor: { localId: 'm1' } } });
        happy!.leadBoard.onTurnStart(['m1']);
        session.emit('claude-session-message', { type: 'assistant', message: { content: [{ type: 'text', text: 'I will, tonight.' }] } });
        session.emit('claude-session-message', { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } });
        session.emit('turn-ended', 'completed');
        await happy!.leadBoard.idle();
        expect(state.calls.find(c => c.op === 'patch')?.body).toMatchObject({ firstReply: { localId: 'm1', snippet: 'I will, tonight.' } });
        expect(state.calls.find(c => c.op === 'resolve')?.body).toMatchObject({ outcome: 'answered', by: 'auto-first-reply' });
    });
});
