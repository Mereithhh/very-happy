import { describe, expect, it, vi } from 'vitest';
import { createProjectsClient, ProjectRequestError, ProjectsUnsupportedError, UNSUPPORTED_BACKOFF_MS } from './client';

const res = (status: number, body: unknown) => new Response(body === undefined ? 'nope' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('projects client compatibility', () => {
    it('an old server (unknown route 404) disables the client for the backoff window', async () => {
        let t = 0;
        const fetch = vi.fn(async () => res(404, { message: 'Route GET:/v1/projects/session/s/context not found', error: 'Not Found', statusCode: 404 }));
        const c = createProjectsClient({ serverUrl: 'http://x', token: async () => 't', fetch: fetch as any, now: () => t });
        await expect(c.context('s')).rejects.toBeInstanceOf(ProjectsUnsupportedError);
        expect(c.isDisabled()).toBe(true);
        await expect(c.digest('s', 0)).rejects.toBeInstanceOf(ProjectsUnsupportedError);
        expect(fetch).toHaveBeenCalledTimes(1);
        t = UNSUPPORTED_BACKOFF_MS + 1;
        expect(c.isDisabled()).toBe(false);
    });
    it('the server kill switch is treated the same as an old server', async () => {
        const c = createProjectsClient({ serverUrl: 'http://x', token: async () => 't', fetch: (async () => res(404, { error: 'projects_disabled' })) as any });
        await expect(c.membership('s')).rejects.toBeInstanceOf(ProjectsUnsupportedError);
    });
    it('a 404 naming a project object and other errors are ordinary failures with the code', async () => {
        const c = createProjectsClient({ serverUrl: 'http://x', token: async () => 't', fetch: (async () => res(404, { error: 'project_not_found' })) as any });
        await expect(c.note('p', { kind: 'finding', title: 't', authorSessionId: 's' })).rejects.toMatchObject({ status: 404, code: 'project_not_found' });
        expect(c.isDisabled()).toBe(false);
        const q = createProjectsClient({ serverUrl: 'http://x', token: async () => 't', fetch: (async () => res(429, { error: 'project_note_quota_exceeded', suggestion: 'fold it' })) as any });
        const error = await q.note('p', { kind: 'finding', title: 't', authorSessionId: 's' }).catch(e => e);
        expect(error).toBeInstanceOf(ProjectRequestError);
        expect(error.details).toEqual({ suggestion: 'fold it' });
    });
    it('sends the account bearer and JSON body', async () => {
        const fetch = vi.fn(async (_url: string, _init: RequestInit) => res(200, { memberships: {} }));
        const c = createProjectsClient({ serverUrl: 'http://x', token: async () => 'tok', fetch: fetch as any });
        await c.presence('m', [{ sessionId: 's', state: 'idle' }], ['g']);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('http://x/v1/projects/presence');
        expect((init.headers as any).authorization).toBe('Bearer tok');
        expect(JSON.parse(String(init.body))).toEqual({ machineId: 'm', sessions: [{ sessionId: 's', state: 'idle' }], gone: ['g'] });
    });
});
