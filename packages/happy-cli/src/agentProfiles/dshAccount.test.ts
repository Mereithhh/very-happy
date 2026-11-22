import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './accountService';
import { checkDshAccount, DSH_CHECK_URL } from './checkAccount';
import { loadDshWrapperAccount, resolveDshAccount } from './dshAccount';
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
