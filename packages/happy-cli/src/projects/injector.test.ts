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
        const client = fakeClient({ context: vi.fn(async () => ctx({ unread: [{ id: 'u1', fromSessionId: 's2', body: 'hi', createdAt: 1 }] })) });
        await make(client).decorate('x');
        expect(client.delivered).toHaveBeenCalledWith('s1', ['u1']);
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
});
