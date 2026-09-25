import { describe, expect, it, vi } from 'vitest';
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://relay.test', currentCliVersion: '0.0.0-test' } }));
vi.mock('@/persistence', () => ({ readCredentialsForConfiguredRelay: vi.fn(), readSettings: vi.fn() }));
import { AUTOMATIONS_UNAVAILABLE_MESSAGE, AutomationsRequestError, automationRunIdFromEnv, createAutomationsClient, isAutomationsUnavailable } from './client';

function respond(status: number, body: unknown): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('automations client', () => {
    it('sends bearer auth, the client tag and query strings; unwraps envelopes', async () => {
        const fetch = respond(200, { runs: [{ id: 'r1' }] });
        const client = createAutomationsClient({ serverUrl: 'http://relay.test/', token: 'tok', fetch, client: 'cli-auto' });
        expect(await client.runs({ name: 'nightly', attention: true, limit: 5 })).toEqual([{ id: 'r1' }]);
        const [url, init] = (fetch as any).mock.calls[0];
        expect(url).toBe('http://relay.test/v1/automations/runs?name=nightly&attention=1&limit=5');
        expect(init.headers.authorization).toBe('Bearer tok');
        expect(init.headers['x-happy-client']).toBe('cli-auto/0.0.0-test');
        expect(init.redirect).toBe('error');
    });
    it('tells an absent feature (old server / gate off) from a lookup miss', async () => {
        const gated = createAutomationsClient({ serverUrl: 'http://relay.test', token: 't', fetch: respond(404, { error: 'automations_disabled' }) });
        const error = await gated.list().catch((e) => e);
        expect(error).toBeInstanceOf(AutomationsRequestError);
        expect(isAutomationsUnavailable(error)).toBe(true);
        expect(error.message).toBe(AUTOMATIONS_UNAVAILABLE_MESSAGE);
        const old = createAutomationsClient({ serverUrl: 'http://relay.test', token: 't', fetch: respond(404, { message: 'Route not found', error: 'Not Found', statusCode: 404 }) });
        expect(isAutomationsUnavailable(await old.claim({ machineId: 'm' }).catch((e) => e))).toBe(true);
        const missing = createAutomationsClient({ serverUrl: 'http://relay.test', token: 't', fetch: respond(404, { error: 'automation_not_found' }) });
        const miss = await missing.getByName('nope').catch((e) => e);
        expect(isAutomationsUnavailable(miss)).toBe(false);
        expect(miss.message).toContain('No automation');
    });
    it('surfaces the server run status on a finished-run conflict and never echoes bodies', async () => {
        const client = createAutomationsClient({ serverUrl: 'http://relay.test', token: 't', fetch: respond(409, { error: 'run_finished', status: 'cancelled', secret: 'do-not-print' }) });
        const error: AutomationsRequestError = await client.report('r', { claimId: 'c', status: 'done' }).catch((e) => e);
        expect(error.status).toBe(409);
        expect(error.code).toBe('run_finished');
        expect(error.runStatus).toBe('cancelled');
        expect(error.message).not.toContain('do-not-print');
    });
    it('reports transport failures as unknown outcomes', async () => {
        const client = createAutomationsClient({ serverUrl: 'http://relay.test', token: 't', fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any });
        await expect(client.list()).rejects.toThrow('outcome may be unknown');
    });
    it('reads the run id only from a well-formed VH_AUTOMATION_RUN_ID', () => {
        expect(automationRunIdFromEnv({ VH_AUTOMATION_RUN_ID: 'run_1-a' })).toBe('run_1-a');
        expect(automationRunIdFromEnv({ VH_AUTOMATION_RUN_ID: 'bad id' })).toBeUndefined();
        expect(automationRunIdFromEnv({})).toBeUndefined();
    });
});
