import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const action = vi.fn();
vi.mock('@/ui/Toast', () => ({ toast: { action: (...a: unknown[]) => action(...a), error: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 'tok' } }) }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'http://x' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'c', apiSocket: { request: async () => new Response(JSON.stringify({ error: 'owner_login_required' }), { status: 403 }) } }));

import { actOnTeam, TeamsApiError } from './teams';
import { ProjectsApiError } from './projectsError';
import { SessionShareApiError } from './apiSessionShares';
import { createSessionGrant } from './apiSessionShares';

const denied = () => new Response(JSON.stringify({ error: 'owner_login_required' }), { status: 403 });

const flush = () => new Promise(r => setTimeout(r, 0));
describe('B-927a: owner_login_required prompts a re-login on teams / projects / shares requests', () => {
    let clock = 1_000_000;
    beforeEach(() => { clock += 60_000; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock); action.mockClear(); vi.stubGlobal('window', { location: { assign: vi.fn() } }); });
    afterEach(() => vi.useRealTimers());
    it('teams', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => denied()));
        await expect(actOnTeam('t', { type: 'archive' } as never, 'r')).rejects.toMatchObject({ status: 403, code: 'owner_login_required' });
        await flush();
        expect(action).toHaveBeenCalledTimes(1);
        expect(TeamsApiError).toBeTruthy();
    });
    it('shares (never an auth failure)', async () => {
        await expect(createSessionGrant('s', { accountId: 'a' } as never, 'viewer')).rejects.toBeInstanceOf(SessionShareApiError);
        await flush();
        expect(action).toHaveBeenCalledTimes(1);
    });
    it('projects reads the 403 body before the auth-failure check', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => denied()));
        const projects = await import('./projects');
        await expect((projects as any).projectsApi.update('p', { defaults: { permissionMode: 'bypassPermissions' } })).rejects.toBeInstanceOf(ProjectsApiError);
        await flush();
        expect(action).toHaveBeenCalledTimes(1);
    });
});
