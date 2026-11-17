import { describe, expect, it, vi } from 'vitest';
import type { ProjectDigest, ProjectSessionContext } from '@slopus/happy-wire';
import { createProjectInjector } from './injector';
import { ProjectsUnsupportedError, type ProjectsClient } from './client';

const project = { id: 'p1', name: 'very-happy', goal: null, instructions: 'Use pnpm.', instructionsVersion: 3 };
const ctx = (over: Partial<ProjectSessionContext> = {}): ProjectSessionContext => ({ project, via: 'explicit', team: null, decisions: [], log: [], sessions: [], unread: [], asOf: 1000, previousReadAt: 0, ...over });
const digest = (over: Partial<ProjectDigest> = {}): ProjectDigest => ({ projectId: 'p1', name: 'very-happy', instructions: null, decisions: [], revoked: [], messages: [], asOf: 2000, ...over });

function fakeClient(over: Partial<Record<keyof ProjectsClient, any>> = {}) {
    const c = {
        isDisabled: vi.fn(() => false),
        context: vi.fn(async () => ctx()),
        digest: vi.fn(async () => digest()),
        presence: vi.fn(async () => ({ memberships: {} })),
        delivered: vi.fn(async () => ({ delivered: 1 })),
        membership: vi.fn(), note: vi.fn(), revoke: vi.fn(), message: vi.fn(),
        ...over,
    };
    return c as unknown as ProjectsClient & typeof c;
}
const make = (client: ProjectsClient, meta: Record<string, any> | null = { machineId: 'm1', capabilities: ['project-v1'], summary: { text: 'fix sidebar' } }) =>
    createProjectInjector({ client, sessionId: () => 's1', metadata: () => meta, agent: 'claude', timeoutMs: 50 });

describe('project injector', () => {
    it('first turn: prefix once, then only a digest when something changed', async () => {
        const client = fakeClient();
        const inj = make(client);
        const first = await inj.decorate('hello');
        expect(first.startsWith('[Very Happy project "very-happy" · instructions v3')).toBe(true);
        expect(first.endsWith('---\nhello')).toBe(true);
        expect(inj.state()).toMatchObject({ projectId: 'p1', prefixSent: true, cursor: 1000, injectedVersion: 3 });
        expect(await inj.decorate('second')).toBe('second');
        expect(client.digest).toHaveBeenLastCalledWith('s1', 1000, 50);
        client.digest.mockResolvedValueOnce(digest({ instructions: { version: 4, summary: 'tighten' }, asOf: 3000 }));
        expect(await inj.decorate('third')).toBe('[Project "very-happy" since your last turn: instructions now v4 — tighten]\nthird');
        expect(inj.state()).toMatchObject({ cursor: 3000, injectedVersion: 4 });
        expect(client.context).toHaveBeenCalledTimes(1);
    });
    it('reports the injected version and capabilities through presence', async () => {
        const client = fakeClient();
        await make(client).decorate('x');
        expect(client.presence).toHaveBeenCalledWith('m1', [expect.objectContaining({ sessionId: 's1', injectedInstructionsVersion: 3, capabilities: ['project-v1'], title: 'fix sidebar', agent: 'claude' })]);
    });
    it('a session outside any project is untouched, and joins later get the prefix on the next turn', async () => {
        const client = fakeClient({ context: vi.fn(async () => ctx({ project: null })) });
        const inj = make(client);
        expect(await inj.decorate('a')).toBe('a');
        expect(client.presence).not.toHaveBeenCalled();
        client.context.mockResolvedValueOnce(ctx());
        expect((await inj.decorate('b')).endsWith('---\nb')).toBe(true);
    });
    it('marks the unread messages it injected as delivered', async () => {
        const client = fakeClient({ context: vi.fn(async () => ctx({ sharing: 'shared', unread: [{ id: 'u1', fromSessionId: 's2', body: 'hi', createdAt: 1 }] })) });
        await make(client).decorate('x');
        expect(client.delivered).toHaveBeenCalledWith('s1', ['u1']);
    });
    it('B-939b: an isolated session (the default; an older server sends no sharing) gets no other sessions or notes — messages to it still arrive (B-939c)', async () => {
        const client = fakeClient({ context: vi.fn(async () => ctx({
            unread: [{ id: 'u1', fromSessionId: 's2', body: 'please take over Z', createdAt: 1 }],
            sessions: [{ sessionId: 's2', projectId: 'p1', machineId: 'm', title: 'notify list', agent: 'claude', machine: null, branch: null, state: 'running', doing: null, injectedInstructionsVersion: 1, capabilities: [], updatedAt: 1 }],
            decisions: [
                { id: 'd1', seq: 1, title: 'ship server first', createdAt: 1, authorUser: true, authorSessionId: null },
                { id: 'd2', seq: 2, title: 'Z belongs to s1', createdAt: 2, authorUser: false, authorSessionId: 's2' },
            ],
        })) });
        const inj = make(client);
        const first = await inj.decorate('x');
        expect(first).toContain('Decisions in effect:\n#1 ship server first');
        expect(first).not.toMatch(/Z belongs to s1|notify list|Other active sessions/);
        expect(first).toContain('The user keeps this project\'s sessions separate');
        expect(first).toContain('please take over Z');
        expect(client.delivered).toHaveBeenCalledWith('s1', ['u1']);
        // Next turn: only the user's decisions; a message to this session still comes through.
        client.digest.mockResolvedValueOnce(digest({
            decisions: [{ id: 'd3', seq: 3, title: 'X is mine now', authorUser: false, authorSessionId: 's2' }],
        }));
        expect(await inj.decorate('y')).toBe('y');
        client.digest.mockResolvedValueOnce(digest({ decisions: [{ id: 'd4', seq: 4, title: 'freeze Friday', authorUser: true, authorSessionId: null }] }));
        expect(await inj.decorate('z')).toContain('decision #4: freeze Friday');
    });
    it('B-939b: a shared project keeps the B-939 behaviour; a team session shares even in an isolated project', async () => {
        const peer = { sessionId: 's2', projectId: 'p1', machineId: 'm', title: 'notify list', agent: 'claude', machine: null, branch: null, state: 'running', doing: null, injectedInstructionsVersion: 1, capabilities: [], updatedAt: 1 };
        const shared = fakeClient({ context: vi.fn(async () => ctx({ sharing: 'shared', sessions: [peer] })) });
        expect(await make(shared).decorate('x')).toContain('notify list');
        const team = fakeClient({ context: vi.fn(async () => ctx({ sharing: 'isolated', via: 'team', team: { id: 't', name: 'T' }, decisions: [{ id: 'd2', seq: 2, title: 'lead rule', createdAt: 2, authorUser: false, authorSessionId: 'lead', authorTeamLead: true }] })) });
        const inj = make(team);
        expect(await inj.decorate('x')).toContain('Decisions in effect:\n#2 lead rule');
        team.digest.mockResolvedValueOnce(digest({ sharing: 'isolated', messages: [{ id: 'u2', fromSessionId: 's2', body: 'ping', createdAt: 2 }] }));
        expect(await inj.decorate('y')).toContain('ping');
    });
    it('leaving the project resets; moving to another re-sends a prefix for the new one', async () => {
        const client = fakeClient();
        const inj = make(client);
        await inj.decorate('x');
        client.digest.mockResolvedValueOnce(digest({ projectId: null, name: null }));
        expect(await inj.decorate('y')).toBe('y');
        expect(inj.state().prefixSent).toBe(false);
        await inj.decorate('z');
        client.digest.mockResolvedValueOnce(digest({ projectId: 'p2', name: 'other' }));
        client.context.mockResolvedValueOnce(ctx({ project: { ...project, id: 'p2', name: 'other' } }));
        expect(await inj.decorate('w')).toContain('[Very Happy project "other"');
    });
    it('degrades to the plain message: old server, disabled backoff, timeout, error', async () => {
        const old = fakeClient({ context: vi.fn(async () => { throw new ProjectsUnsupportedError(); }) });
        expect(await make(old).decorate('m')).toBe('m');
        const disabled = fakeClient({ isDisabled: vi.fn(() => true) });
        expect(await make(disabled).decorate('m')).toBe('m');
        expect(disabled.context).not.toHaveBeenCalled();
        const slow = fakeClient({ context: vi.fn(() => new Promise(() => {})) });
        const t0 = Date.now();
        expect(await make(slow).decorate('m')).toBe('m');
        expect(Date.now() - t0).toBeLessThan(1000);
        const broken = fakeClient({ context: vi.fn(async () => { throw new Error('ECONNRESET'); }) });
        expect(await make(broken).decorate('m')).toBe('m');
    });
    it('never touches a structured message and never calls the server for it', async () => {
        const client = fakeClient();
        const blocks = [{ type: 'text', text: 'x' }];
        expect(await make(client).decorate(blocks)).toBe(blocks);
        expect(client.context).not.toHaveBeenCalled();
    });
    it('reset() makes the next turn carry the prefix again (fresh agent with no memory)', async () => {
        const client = fakeClient();
        const inj = make(client);
        await inj.decorate('x');
        inj.reset();
        expect((await inj.decorate('y')).endsWith('---\ny')).toBe(true);
        expect(client.context).toHaveBeenCalledTimes(2);
    });
    it('B-877b: the one-time team-exit note rides on every agent\'s turn, first in line, even with projects off', async () => {
        const notice = { decorate: vi.fn((m: string) => `[team mode ended]\n${m}`) };
        const issueDigest = { decorate: vi.fn(async (m: string) => `[Issue VH-1 now todo]\n${m}`) };
        for (const agent of ['claude', 'codex']) {
            const inj = createProjectInjector({ client: fakeClient(), sessionId: () => 's1', metadata: () => null, agent, timeoutMs: 50, issueDigest, teamExitNotice: notice });
            expect((await inj.decorate('hi')).startsWith('[team mode ended]\n[Issue VH-1 now todo]\n[Very Happy project')).toBe(true);
            const off = createProjectInjector({ client: fakeClient({ isDisabled: vi.fn(() => true) }), sessionId: () => 's1', agent, issueDigest: null, teamExitNotice: notice });
            expect(await off.decorate('hi')).toBe('[team mode ended]\nhi');
        }
    });
    it('B-877c: the language rule rides on every agent\'s turn, reads the raw message, and works with projects off', async () => {
        const backfill = { decorate: vi.fn((m: string, source: string) => `[rule for ${source}]\n${m}`) };
        for (const agent of ['claude', 'codex']) {
            const inj = createProjectInjector({ client: fakeClient(), sessionId: () => 's1', metadata: () => null, agent, timeoutMs: 50, issueDigest: null, teamExitNotice: null, teamLanguageBackfill: backfill });
            expect((await inj.decorate('hi')).startsWith('[rule for hi]\n[Very Happy project')).toBe(true);
            const off = createProjectInjector({ client: fakeClient({ isDisabled: vi.fn(() => true) }), sessionId: () => 's1', agent, issueDigest: null, teamExitNotice: null, teamLanguageBackfill: backfill });
            expect(await off.decorate('hi')).toBe('[rule for hi]\nhi');
        }
    });
});

/**
 * B-939c: a message another session stored for this one while it was offline
 * reached the agent only in a shared project, and only as text in front of the
 * user's message (origin human). Isolation (B-939b) filtered it out entirely,
 * though the sender was told it would be read at the next turn. It now goes to
 * the agent as its own session message — the live envelope and channel, so
 * NON-USER on Claude — in both modes, once.
 */
describe('B-939c: stored messages reach the recipient like live session messages', () => {
    const stored = (id: string, body: string | null = `body ${id}`) => ({ id, fromSessionId: 'sender-session-1', body, createdAt: 1 });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const withPost = (client: ProjectsClient, post = vi.fn(async (_text: string, _localId: string) => {})) => ({
        post, inj: createProjectInjector({ client, sessionId: () => 's1', metadata: () => null, agent: 'claude', timeoutMs: 50, postToSelf: post }),
    });

    for (const sharing of ['isolated', 'shared'] as const) {
        it(`${sharing}: first turn posts each unread message once as a session message, then marks it delivered; the user's text is left alone`, async () => {
            const client = fakeClient({ context: vi.fn(async () => ctx({ sharing, unread: [stored('m1-aaaaaaaa'), stored('m2-bbbbbbbb')] })) });
            const { post, inj } = withPost(client);
            const out = await inj.decorate('owner text');
            expect(out.endsWith('---\nowner text')).toBe(true);
            expect(out).not.toMatch(/body m1|body m2|Unread messages/);
            expect(post).toHaveBeenCalledTimes(2);
            const [text, localId] = post.mock.calls[0];
            expect(text).toMatch(/^\[Very Happy session message m1-aaaaa from "" sender-session-1\]\nbody m1-aaaaaaaa\n\nThis message comes from another agent session/);
            expect(localId).toBe('project-msg-m1-aaaaaaaa');
            await flush();
            expect(client.delivered).toHaveBeenCalledWith('s1', ['m1-aaaaaaaa']);
            expect(client.delivered).toHaveBeenCalledWith('s1', ['m2-bbbbbbbb']);
        });
        it(`${sharing}: a later turn posts the digest's messages (all of them, not just the first) and never the same one twice`, async () => {
            const client = fakeClient({ context: vi.fn(async () => ctx({ sharing })) });
            const { post, inj } = withPost(client);
            await inj.decorate('x');
            client.digest.mockResolvedValue(digest({ sharing, messages: [stored('m3'), stored('m4')] }));
            expect(await inj.decorate('y')).toBe('y');
            // The ack has not landed yet when the posted message's own turn asks again.
            expect(await inj.decorate('z')).toBe('z');
            expect(post.mock.calls.map((c) => c[1])).toEqual(['project-msg-m3', 'project-msg-m4']);
        });
    }
    it('a post that fails is not marked delivered and is tried again next turn', async () => {
        const client = fakeClient({ context: vi.fn(async () => ctx({ unread: [stored('m5')] })) });
        const post = vi.fn(async (_text: string, _localId: string): Promise<void> => { throw new Error('offline'); });
        const { inj } = withPost(client, post);
        await inj.decorate('x');
        await flush();
        expect(client.delivered).not.toHaveBeenCalled();
        post.mockResolvedValueOnce(undefined);
        client.digest.mockResolvedValueOnce(digest({ messages: [stored('m5')] }));
        await inj.decorate('y');
        await flush();
        expect(post).toHaveBeenCalledTimes(2);
        expect(client.delivered).toHaveBeenCalledWith('s1', ['m5']);
    });
    it('an erased body (delivered elsewhere > 7 days ago) is acked without posting', async () => {
        const client = fakeClient({ context: vi.fn(async () => ctx({ unread: [stored('m6', null)] })) });
        const { post, inj } = withPost(client);
        await inj.decorate('x');
        expect(post).not.toHaveBeenCalled();
        expect(client.delivered).toHaveBeenCalledWith('s1', ['m6']);
    });
    it('without a channel (postToSelf absent) the message still reaches the isolated session as the text line', async () => {
        const client = fakeClient({ context: vi.fn(async () => ctx({ sharing: 'isolated' })) });
        const inj = make(client);
        await inj.decorate('x');
        client.digest.mockResolvedValueOnce(digest({ sharing: 'isolated', messages: [stored('m7', 'MK-ping')] }));
        expect(await inj.decorate('y')).toContain('MK-ping');
        expect(client.delivered).toHaveBeenCalledWith('s1', ['m7']);
    });
});
