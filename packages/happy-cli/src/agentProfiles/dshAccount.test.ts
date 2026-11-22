import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './accountService';
import { checkDshAccount, classifyDshGatewayCheck, dshMessagesRoot, DSH_CHECK_URL, DSH_GATEWAY_CHECK_MODEL } from './checkAccount';
import { dshBaseUrlProblem, dshChildEnv, loadDshWrapperAccount, resolveDshAccount } from './dshAccount';
import { accountSecretPath, parseAccountsFile, writeSessionBinding, type AccountsFile } from './store';

// Fake key, assembled at runtime so secret scanners do not flag a test literal.
const KEY = ['sk', 'test', 'deepseek', 'not', 'real'].join('-');

const accounts = (extra: Partial<AccountsFile['accounts'][string]> = {}): AccountsFile => ({
    version: 2,
    defaults: {},
    accounts: { ds: { label: 'DeepSeek', agent: 'dsh', kind: 'dsh-api', createdAt: 1, key: { source: 'stored' }, ...extra } },
});

describe('B-952 dsh-api accounts', () => {
    it('resolves the bound key from the stored secret, a key file or an env variable', () => {
        const base = { home: '/h', bindings: { s1: { account: 'ds' } }, env: { MY_DS_KEY: ` ${KEY} ` } };
        const readSecret = vi.fn((path: string) => `${KEY}\n${path === accountSecretPath('/h', 'ds') ? '' : ''}`);
        expect(resolveDshAccount('s1', { ...base, accounts: accounts(), readSecret })).toEqual({
            kind: 'active', id: 'ds', key: KEY, profile: { id: 'ds', label: 'DeepSeek', kind: 'dsh-api', status: 'active' },
        });
        expect(readSecret).toHaveBeenCalledWith(accountSecretPath('/h', 'ds'));
        expect(resolveDshAccount('s1', { ...base, accounts: accounts({ key: { source: 'env', name: 'MY_DS_KEY' } }), readSecret })).toMatchObject({ kind: 'active', key: KEY });
        expect(resolveDshAccount('s1', { ...base, accounts: accounts({ key: { source: 'file', path: '/k' } }), readSecret: () => KEY })).toMatchObject({ kind: 'active', key: KEY });
    });

    it('an unbound session keeps the machine setup; an unusable binding never falls back', () => {
        const deps = { home: '/h', env: {}, readSecret: () => KEY };
        expect(resolveDshAccount('s1', { ...deps, accounts: accounts(), bindings: {} })).toEqual({ kind: 'machine' });
        expect(resolveDshAccount('s1', { ...deps, accounts: accounts(), bindings: { s1: { account: null } } })).toEqual({ kind: 'machine' });
        expect(resolveDshAccount('s1', { ...deps, accounts: accounts(), bindings: { s1: { account: 'gone' } } })).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing' } });
        expect(resolveDshAccount('s1', { ...deps, accounts: accounts({ check: { status: 'invalid', at: 1 } }), bindings: { s1: { account: 'ds' } } })).toMatchObject({ kind: 'unavailable', profile: { reason: 'invalid' } });
        expect(resolveDshAccount('s1', { ...deps, accounts: accounts(), bindings: { s1: { account: 'ds' } }, readSecret: () => { throw new Error('ENOENT'); } })).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing-secret' } });
        const claude: AccountsFile = { version: 2, defaults: {}, accounts: { ds: { label: 'C', agent: 'claude', kind: 'claude-api', createdAt: 1, baseUrl: 'https://x', key: { source: 'stored' } } } };
        expect(resolveDshAccount('s1', { ...deps, accounts: claude, bindings: { s1: { account: 'ds' } } })).toMatchObject({ kind: 'unavailable', profile: { reason: 'agent-mismatch' } });
    });

    it('the wrapper hands the key to the dsh child as DEEPSEEK_API_KEY and records the spawn binding', async () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-b952-acct-'));
        const svc = new AccountService({ home, env: {}, now: () => 5, daemonPid: 1, check: async () => ({ status: 'ok', at: 7 }) });
        const added = await svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'DeepSeek', key: { source: 'paste', value: KEY } });
        expect(added).toMatchObject({ id: 'deepseek', agent: 'dsh', kind: 'dsh-api', status: 'ok', keySource: 'stored' });
        expect(JSON.stringify(added)).not.toContain(KEY);
        expect(readFileSync(join(home, 'accounts.json'), 'utf8')).not.toContain(KEY);
        expect(statSync(accountSecretPath(home, 'deepseek')).mode & 0o777).toBe(0o600);
        expect(svc.resolveSpawnAccount('dsh', 'deepseek')).toBe('deepseek');
        expect(() => svc.resolveSpawnAccount('claude', 'deepseek')).toThrow(/agent-mismatch/);

        const env: NodeJS.ProcessEnv = {};
        const wrapper = loadDshWrapperAccount(home, 'sess-1', 'deepseek', env);
        expect(wrapper).toMatchObject({ unavailable: false, profile: { id: 'deepseek', status: 'active' }, childEnv: { DEEPSEEK_API_KEY: KEY } });
        expect(env.DEEPSEEK_API_KEY).toBeUndefined();
        expect(JSON.stringify(wrapper.profile)).not.toContain(KEY);
        // The binding sticks: the next wrapper (resume) needs no spawn env.
        expect(loadDshWrapperAccount(home, 'sess-1', undefined, env).childEnv).toEqual({ DEEPSEEK_API_KEY: KEY });
        writeSessionBinding(home, 'sess-2', { account: null });
        expect(loadDshWrapperAccount(home, 'sess-2', 'deepseek', env)).toMatchObject({ profile: null, childEnv: {} });
    });

    it('accounts.json keeps dsh-api entries with a key and drops them without one', () => {
        const parsed = parseAccountsFile({ accounts: {
            ok: { label: 'D', agent: 'dsh', kind: 'dsh-api', key: { source: 'env', name: 'DEEPSEEK_API_KEY' } },
            nokey: { label: 'D', agent: 'dsh', kind: 'dsh-api' },
            wrongagent: { label: 'D', agent: 'claude', kind: 'dsh-api', key: { source: 'stored' } },
        } });
        expect(Object.keys(parsed.accounts)).toEqual(['ok']);
    });

    it('checks the key against DeepSeek\'s model list: 2xx ok, 401 invalid, network unverified', async () => {
        const fetchOk = vi.fn(async () => new Response('{}', { status: 200 }));
        expect(await checkDshAccount(KEY, () => 3, fetchOk as unknown as typeof fetch)).toEqual({ status: 'ok', at: 3 });
        expect(fetchOk).toHaveBeenCalledWith(DSH_CHECK_URL, expect.objectContaining({ method: 'GET', headers: { authorization: `Bearer ${KEY}` } }));
        const fetch401 = async () => new Response(`Authentication Fails, Your api key: ${KEY} is invalid`, { status: 401 });
        expect(await checkDshAccount(KEY, () => 3, fetch401 as unknown as typeof fetch)).toEqual({ status: 'invalid', at: 3, detail: 'HTTP 401' });
        const fetchDown = async () => { throw new Error('getaddrinfo ENOTFOUND api.deepseek.com'); };
        const down = await checkDshAccount(KEY, () => 3, fetchDown as unknown as typeof fetch);
        expect(down.status).toBe('unverified');
        expect(JSON.stringify(down)).not.toContain(KEY);
    });
});

const GW = 'https://your-gateway.example.com';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('B-957 dsh-api Base URL', () => {
    it('validates the Base URL as dsh does: an http(s) root, no credentials, query or fragment', () => {
        expect(dshBaseUrlProblem(GW)).toBeNull();
        expect(dshBaseUrlProblem('http://10.0.0.5:8080/anthropic')).toBeNull();
        expect(dshBaseUrlProblem('ftp://example.com')).toMatch(/http/);
        expect(dshBaseUrlProblem('not a url')).toMatch(/http/);
        expect(dshBaseUrlProblem('https://u:p@example.com')).toMatch(/credentials/);
        expect(dshBaseUrlProblem('https://example.com/?a=1')).toMatch(/query/);
        expect(dshBaseUrlProblem('https://example.com/#x')).toMatch(/fragment/);
    });

    it('add keeps an optional baseUrl (trimmed of trailing /) and rejects a bad one; none = unchanged', async () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-b957-add-'));
        const svc = new AccountService({ home, env: {}, now: () => 5, daemonPid: 1, check: async () => ({ status: 'ok', at: 7 }) });
        const gw = await svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Gateway', baseUrl: `${GW}/`, key: { source: 'paste', value: KEY } });
        expect(gw).toMatchObject({ kind: 'dsh-api', baseUrl: GW, status: 'ok' });
        expect(JSON.parse(readFileSync(join(home, 'accounts.json'), 'utf8')).accounts.gateway.baseUrl).toBe(GW);
        const plain = await svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Plain', key: { source: 'paste', value: KEY } });
        expect(plain.baseUrl).toBeUndefined();
        await expect(svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Bad', baseUrl: 'https://example.com/?k=1', key: { source: 'paste', value: KEY } })).rejects.toMatchObject({ code: 'invalid-params' });
        await expect(svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Bad', baseUrl: 'ftp://example.com', key: { source: 'paste', value: KEY } })).rejects.toMatchObject({ code: 'invalid-params' });
        expect(Object.keys(svc.state().accounts.map((a) => a.id))).toHaveLength(2);
    });

    it('the Base URL reaches the dsh child only, as DEEPSEEK_BASE_URL — never the wrapper env or metadata', async () => {
        expect(dshChildEnv(KEY)).toEqual({ DEEPSEEK_API_KEY: KEY });
        expect(dshChildEnv(KEY, GW)).toEqual({ DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: GW });
        const home = mkdtempSync(join(tmpdir(), 'vh-b957-env-'));
        const svc = new AccountService({ home, env: {}, now: () => 5, daemonPid: 1, check: async () => ({ status: 'ok', at: 7 }) });
        await svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Gateway', baseUrl: GW, key: { source: 'paste', value: KEY } });
        await svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Plain', key: { source: 'paste', value: KEY } });
        const env: NodeJS.ProcessEnv = {};
        const gw = loadDshWrapperAccount(home, 'sess-gw', 'gateway', env);
        expect(gw.childEnv).toEqual({ DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: GW });
        expect(env.DEEPSEEK_BASE_URL).toBeUndefined();
        expect(JSON.stringify(gw.profile)).not.toContain(GW);
        // No Base URL: exactly the B-952 env (the machine's DEEPSEEK_BASE_URL, if any, is left alone).
        expect(loadDshWrapperAccount(home, 'sess-plain', 'plain', env).childEnv).toEqual({ DEEPSEEK_API_KEY: KEY });
        // Machine setup: nothing added.
        expect(loadDshWrapperAccount(home, 'sess-machine', undefined, env).childEnv).toEqual({});
    });

    it('the test goes to the gateway: GET <root>/v1/models with the key; a JSON list is ok, 401/403 the key', async () => {
        expect(dshMessagesRoot(GW)).toBe(`${GW}/v1`);
        expect(dshMessagesRoot(`${GW}/v1/`)).toBe(`${GW}/v1`);
        expect(dshMessagesRoot(`${GW}/anthropic`)).toBe(`${GW}/anthropic/v1`);
        const ok = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [{ id: 'deepseek-v4-flash' }] }));
        expect(await checkDshAccount(KEY, () => 3, ok as unknown as typeof fetch, GW)).toEqual({ status: 'ok', at: 3 });
        expect(ok).toHaveBeenCalledTimes(1);
        expect(ok.mock.calls[0][0]).toBe(`${GW}/v1/models`);
        expect(ok.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${KEY}`, 'x-api-key': KEY } });
        for (const status of [401, 403]) {
            const rejected = async () => json({ error: { message: `invalid key ${KEY}` } }, status);
            expect(await checkDshAccount(KEY, () => 3, rejected as unknown as typeof fetch, GW)).toEqual({ status: 'invalid', at: 3, detail: `HTTP ${status}` });
        }
        // No Base URL: DeepSeek's own model list, as before.
        const official = vi.fn(async () => new Response('{}', { status: 200 }));
        await checkDshAccount(KEY, () => 3, official as unknown as typeof fetch);
        expect(official).toHaveBeenCalledWith(DSH_CHECK_URL, expect.anything());
    });

    it('a gateway without a model list gets one 1-token Messages request; 404 / an HTML page / no connection = the address', async () => {
        const calls: Array<[string, RequestInit | undefined]> = [];
        const noList = async (url: string, init?: RequestInit) => {
            calls.push([url, init]);
            return url.endsWith('/models') ? new Response('not found', { status: 404 }) : json({ type: 'message', content: [] });
        };
        expect(await checkDshAccount(KEY, () => 3, noList as unknown as typeof fetch, GW)).toEqual({ status: 'ok', at: 3 });
        expect(calls.map(([u]) => u)).toEqual([`${GW}/v1/models`, `${GW}/v1/messages`]);
        expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ model: DSH_GATEWAY_CHECK_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });

        const nowhere = async () => new Response('not found', { status: 404 });
        expect(await checkDshAccount(KEY, () => 3, nowhere as unknown as typeof fetch, GW)).toEqual({ status: 'unverified', at: 3, reason: 'unreachable', detail: 'HTTP 404' });
        const html = async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        expect(await checkDshAccount(KEY, () => 3, html as unknown as typeof fetch, GW)).toMatchObject({ status: 'unverified', reason: 'unreachable', detail: 'HTTP 200, not an API response' });
        const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
        expect(await checkDshAccount(KEY, () => 3, down as unknown as typeof fetch, GW)).toEqual({ status: 'unverified', at: 3, reason: 'unreachable', detail: 'fetch failed (ENOTFOUND)' });
        // Other failures stay plain 「未验证」 with the code, and never carry the key, whatever its shape.
        const oddKey = 'gw_' + 'x'.repeat(30);
        const echo = async () => new Response(`upstream said ${oddKey}`, { status: 502 });
        const failed = await checkDshAccount(oddKey, () => 3, echo as unknown as typeof fetch, GW);
        expect(failed).toMatchObject({ status: 'unverified' });
        expect(failed.reason).toBeUndefined();
        expect(failed.detail).toMatch(/^HTTP 502/);
        expect(JSON.stringify(failed)).not.toContain(oddKey);
        expect(classifyDshGatewayCheck(405, false, '', 1)).toEqual({ status: 'unverified', at: 1, reason: 'unreachable', detail: 'HTTP 405' });
    });

    it('account test routes by the stored baseUrl and reports statusReason; edit sets / clears it', async () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-b957-svc-'));
        const fetchStub = vi.fn(async (url: string) => (String(url).startsWith(GW) ? new Response('nope', { status: 404 }) : new Response('{}', { status: 200 })));
        vi.stubGlobal('fetch', fetchStub);
        try {
            const svc = new AccountService({ home, env: {}, now: () => 5, daemonPid: 1 });
            const added = await svc.add({ agent: 'dsh', kind: 'dsh-api', label: 'Gateway', baseUrl: GW, key: { source: 'paste', value: KEY } });
            expect(added).toMatchObject({ status: 'unverified', statusReason: 'unreachable', statusDetail: 'HTTP 404' });
            expect(String(fetchStub.mock.calls[0][0])).toBe(`${GW}/v1/models`);
            const cleared = await svc.setBaseUrl('gateway', null);
            expect(cleared).toMatchObject({ status: 'ok' });
            expect(cleared.baseUrl).toBeUndefined();
            expect(cleared.statusReason).toBeUndefined();
            expect(String(fetchStub.mock.calls.at(-1)![0])).toBe(DSH_CHECK_URL);
            await expect(svc.setBaseUrl('gateway', 'https://example.com/?q')).rejects.toMatchObject({ code: 'invalid-params' });
            expect((await svc.setBaseUrl('gateway', `${GW}/`)).baseUrl).toBe(GW);
            await svc.storeSubscriptionToken('sk-ant-oat01-' + 'T'.repeat(20), { label: 'Sub' });
            await expect(svc.setBaseUrl('sub', GW)).rejects.toMatchObject({ code: 'invalid-params' });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
