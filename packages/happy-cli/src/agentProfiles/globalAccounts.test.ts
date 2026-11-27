/**
 * B-981 global model channels on a machine: materialize / merge / remove,
 * read-only for every edit path, unavailable (never the machine login) once a
 * channel disappears, file permissions, and the daemon sync's failure modes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModelChannelsResponse } from '@slopus/happy-wire';
import { AccountError, AccountService } from './accountService';
import { loadCodexWrapperAccount } from './codexWrapperAccount';
import { globalAccountSecretPath, globalAccountsDir, globalAccountsPath, materializeGlobalChannels } from './globalAccounts';
import { syncGlobalChannelsOnce } from './globalChannelSync';
import { newAccountId, readAccounts, readAccountsFileV2, writeAccountsFile, writeSessionBinding } from './store';
import { loadWrapperAccount } from './wrapperAccount';

// Fake key, assembled at runtime so secret scanners do not flag test literals.
const KEY = ['sk', 'channel', 'test'].join('-');

const channels = (over: Partial<ModelChannelsResponse> = {}): ModelChannelsResponse => ({
    revision: 'r1',
    channels: [
        { id: 'team-gw', label: 'Team gateway', agent: 'claude', baseUrl: 'https://gw.example.com/', models: ['model-a', 'model-b'], contextWindows: { 'model-a': 200000 }, apiKey: KEY },
        { id: 'team-cx', label: 'Team Codex', agent: 'codex', baseUrl: 'https://gw.example.com/v1', models: ['model-c'], wireApi: 'responses', apiKey: KEY },
    ],
    ...over,
});

function home() {
    return mkdtempSync(join(tmpdir(), 'vh-b981-'));
}

describe('B-981 materialize global channels', () => {
    it('writes a secret-free registry and 0600 key files (dirs 0700); accounts merge as read-only global entries', () => {
        const dir = home();
        const result = materializeGlobalChannels(dir, channels(), 10);
        expect(result).toEqual({ changed: true, added: ['global-team-gw', 'global-team-cx'], removed: [] });
        const registry = readFileSync(globalAccountsPath(dir), 'utf8');
        expect(registry).not.toContain(KEY);
        expect(statSync(globalAccountsPath(dir)).mode & 0o777).toBe(0o600);
        const keyPath = globalAccountSecretPath(dir, 'team-gw');
        expect(readFileSync(keyPath, 'utf8').trim()).toBe(KEY);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(globalAccountsDir(dir), 'team-gw')).mode & 0o777).toBe(0o700);
        expect(statSync(globalAccountsDir(dir)).mode & 0o777).toBe(0o700);

        const accounts = readAccounts(dir).accounts;
        expect(accounts['global-team-gw']).toEqual({
            label: 'Team gateway', agent: 'claude', kind: 'claude-api', createdAt: 10, baseUrl: 'https://gw.example.com', models: ['model-a', 'model-b'],
            contextWindows: { 'model-a': 200000 }, key: { source: 'file', path: keyPath }, global: true,
        });
        expect(accounts['global-team-cx']).toMatchObject({ agent: 'codex', kind: 'codex-provider', wireApi: 'responses', global: true });
        const svc = new AccountService({ home: dir, env: {}, now: () => 20 });
        const summary = svc.state().accounts.find((a) => a.id === 'global-team-gw');
        expect(summary).toMatchObject({ scope: 'global', status: 'unverified', keySource: 'stored' });
        expect(summary?.keyRef).toBeUndefined();
        expect(JSON.stringify(svc.state())).not.toContain(KEY);
    });

    it('same revision with keys in place writes nothing; a removed channel loses its files; createdAt is kept', () => {
        const dir = home();
        materializeGlobalChannels(dir, channels(), 10);
        expect(materializeGlobalChannels(dir, channels(), 11).changed).toBe(false);
        const next = channels({ revision: 'r2', channels: [channels().channels[0]] });
        expect(materializeGlobalChannels(dir, next, 12)).toEqual({ changed: true, added: [], removed: ['global-team-cx'] });
        expect(existsSync(join(globalAccountsDir(dir), 'team-cx'))).toBe(false);
        expect(readAccounts(dir).accounts['global-team-gw'].createdAt).toBe(10);
        expect(readAccounts(dir).accounts['global-team-cx']).toBeUndefined();
        // a deleted key file is restored on the next sync even with the same revision
        rmSync(globalAccountSecretPath(dir, 'team-gw'));
        expect(materializeGlobalChannels(dir, next, 13).changed).toBe(true);
        expect(readFileSync(globalAccountSecretPath(dir, 'team-gw'), 'utf8').trim()).toBe(KEY);
    });

    it('a channel without a key (Web answer) is never materialized', () => {
        const dir = home();
        const { apiKey: _drop, ...noKey } = channels().channels[0];
        materializeGlobalChannels(dir, { revision: 'w', channels: [noKey] });
        expect(readAccounts(dir).accounts['global-team-gw']).toBeUndefined();
    });

    it('writers drop global entries; a local account with the same id wins; new local ids never take the global prefix', () => {
        const dir = home();
        materializeGlobalChannels(dir, channels());
        writeAccountsFile(dir, readAccounts(dir));
        expect(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).accounts).toEqual({});
        expect(newAccountId('Global team gw', 'claude-api', [])).toBe('my-global-team-gw');
        writeAccountsFile(dir, { version: 2, accounts: { 'global-team-gw': { label: 'Mine', agent: 'claude', kind: 'claude-api', createdAt: 1, baseUrl: 'https://mine.example.com', key: { source: 'stored' } } }, defaults: {} });
        expect(readAccounts(dir).accounts['global-team-gw']).toMatchObject({ label: 'Mine' });
        expect(readAccounts(dir).accounts['global-team-gw'].global).toBeUndefined();
    });
});

describe('B-981 global accounts are read-only on the machine', () => {
    it('rename / remove refuse with global-readonly; test reports without persisting; set-default is allowed and cleared when the channel goes', async () => {
        const dir = home();
        materializeGlobalChannels(dir, channels());
        const onChanged = vi.fn();
        const check = vi.fn(async () => ({ status: 'ok', at: 7 }));
        const svc = new AccountService({ home: dir, env: {}, now: () => 5, onChanged, check });
        expect(() => svc.rename('global-team-gw', 'x')).toThrow(AccountError);
        expect(() => svc.rename('global-team-gw', 'x')).toThrow(/global model channel/);
        await expect(svc.remove('global-team-gw', true)).rejects.toMatchObject({ code: 'global-readonly' });
        const tested = await svc.test('global-team-gw');
        expect(tested).toMatchObject({ status: 'ok', checkedAt: 7, scope: 'global' });
        expect(check).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://gw.example.com' }), KEY);
        expect(readAccountsFileV2(dir).accounts).toEqual({});

        svc.setDefault('claude', 'global-team-gw');
        expect(svc.state().defaults).toEqual({ claude: 'global-team-gw' });
        expect(svc.resolveSpawnAccount('claude', undefined)).toBe('global-team-gw');
        const removed = materializeGlobalChannels(dir, { revision: 'r2', channels: [] });
        await svc.globalChannelsChanged(removed.removed);
        expect(readAccountsFileV2(dir).defaults).toEqual({});
        expect(svc.resolveSpawnAccount('claude', undefined)).toBeNull();
        expect(() => svc.resolveSpawnAccount('claude', 'global-team-gw')).toThrow(/agent-profile-unavailable:missing/);
        expect(onChanged).toHaveBeenCalled();
    });
});

describe('B-981 removed channel restarts its sessions in place', () => {
    it('bound sessions restart (they come back unavailable); others are left alone; binding is kept', async () => {
        const dir = home();
        materializeGlobalChannels(dir, channels());
        const restartSession = vi.fn(async () => ({ ok: true as const }));
        const svc = new AccountService({ home: dir, env: {}, now: () => 5, restartSession });
        svc.writeBinding('s-global', 'global-team-gw');
        svc.writeBinding('s-codex', 'global-team-cx');
        const removed = materializeGlobalChannels(dir, channels({ revision: 'r2', channels: [channels().channels[1]] }));
        expect(await svc.globalChannelsChanged(removed.removed)).toEqual({ 's-global': 'done' });
        expect(restartSession).toHaveBeenCalledTimes(1);
        expect(restartSession).toHaveBeenCalledWith('s-global');
        expect(svc.sessionAccount('s-global')).toBe('global-team-gw');
        expect(await svc.globalChannelsChanged([])).toEqual({});
        expect(restartSession).toHaveBeenCalledTimes(1);
    });
});

describe('B-981 sessions on a global channel', () => {
    it('Claude: apiKeyHelper reads the channel key file; the session is marked global (tagging); after removal it is unavailable, never the machine login', () => {
        const dir = home();
        materializeGlobalChannels(dir, channels());
        const env: NodeJS.ProcessEnv = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'daemon-wide' };
        const a = loadWrapperAccount(dir, 's1', 'global-team-gw', env);
        expect(a).toMatchObject({ unavailable: false, global: true, profile: { id: 'global-team-gw', status: 'active' } });
        expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(JSON.stringify(a.settings)).toContain(globalAccountSecretPath(dir, 'team-gw'));
        expect(JSON.stringify(env)).not.toContain(KEY);

        materializeGlobalChannels(dir, { revision: 'r2', channels: [] });
        const env2: NodeJS.ProcessEnv = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'daemon-wide' };
        const b = loadWrapperAccount(dir, 's1', undefined, env2);
        expect(b).toMatchObject({ unavailable: true, profile: { id: 'global-team-gw', status: 'unavailable', reason: 'missing' } });
        expect(b.global).toBeUndefined();
        expect(env2.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env2.CLAUDE_CODE_OAUTH_TOKEN).toBe('vh-account-unavailable');
    });

    it('Codex: the provider override points at the channel and its key file; after removal unavailable', () => {
        const dir = home();
        const codexHome = join(dir, 'codex');
        mkdirSync(codexHome, { recursive: true });
        materializeGlobalChannels(dir, channels());
        writeSessionBinding(dir, 'c1', { account: 'global-team-cx' });
        const a = loadCodexWrapperAccount(dir, 'c1', undefined, { CODEX_HOME: codexHome, OPENAI_API_KEY: 'x', PATH: '/bin' });
        expect(a).toMatchObject({ unavailable: false, profile: { id: 'global-team-cx', status: 'active', model: 'model-c' }, overrides: { modelProvider: 'vh-global-team-cx' } });
        const table = (a.overrides.config!.model_providers as any)['vh-global-team-cx'];
        expect(table).toMatchObject({ base_url: 'https://gw.example.com/v1', wire_api: 'responses', name: 'Team Codex' });
        expect(table.auth.args.at(-1)).toBe(globalAccountSecretPath(dir, 'team-cx'));
        materializeGlobalChannels(dir, { revision: 'r2', channels: [] });
        const b = loadCodexWrapperAccount(dir, 'c1', undefined, { CODEX_HOME: codexHome, PATH: '/bin' });
        expect(b).toMatchObject({ unavailable: true, profile: { id: 'global-team-cx', status: 'unavailable', reason: 'missing' } });
    });
});

describe('B-981 daemon sync', () => {
    const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

    it('applies the answer with the machine bearer and no redirects', async () => {
        const dir = home();
        const fetch = ok({ revision: 'r1', channels: channels().channels });
        const outcome = await syncGlobalChannelsOnce({ home: dir, serverUrl: 'https://vh.example.com', token: () => 'machine-token', fetch: fetch as any });
        expect(outcome.kind).toBe('applied');
        const [url, init] = (fetch.mock.calls[0] as unknown as [string, RequestInit]);
        expect(url).toBe('https://vh.example.com/v1/model-channels');
        expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer machine-token' } });
        expect(Object.keys(readAccounts(dir).accounts).sort()).toEqual(['global-team-cx', 'global-team-gw']);
    });

    it('network failure, 5xx, 401 and malformed answers keep the last good set; 404 (older server) means no channels', async () => {
        const dir = home();
        await syncGlobalChannelsOnce({ home: dir, serverUrl: 'https://vh.example.com', token: () => 't', fetch: ok({ revision: 'r1', channels: channels().channels }) as any });
        const keep = async (fetch: any) => {
            const outcome = await syncGlobalChannelsOnce({ home: dir, serverUrl: 'https://vh.example.com', token: () => 't', fetch });
            expect(outcome.kind).toBe('kept');
            expect(Object.keys(readAccounts(dir).accounts)).toHaveLength(2);
        };
        await keep(vi.fn(async () => { throw new TypeError('fetch failed'); }));
        await keep(ok({ error: 'x' }, 503));
        await keep(ok({ error: 'x' }, 401));
        await keep(ok({ nope: true }));
        const outcome = await syncGlobalChannelsOnce({ home: dir, serverUrl: 'https://vh.example.com', token: () => 't', fetch: ok({ error: 'Not Found' }, 404) as any });
        expect(outcome).toMatchObject({ kind: 'unsupported', result: { changed: true, removed: ['global-team-gw', 'global-team-cx'] } });
        expect(readAccounts(dir).accounts).toEqual({});
        expect(existsSync(join(globalAccountsDir(dir), 'team-gw'))).toBe(false);
    });

    it('not signed in → no request', async () => {
        const fetch = vi.fn();
        expect(await syncGlobalChannelsOnce({ home: home(), serverUrl: 'https://vh.example.com', token: () => null, fetch: fetch as any })).toMatchObject({ kind: 'kept' });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('B-981 daemon wiring (source assertions, verified with scripts/dev/mutation-check.mjs)', () => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    it('the daemon syncs channels with its machine token and republishes through the account service', () => {
        const run = read('daemon/run.ts');
        expect(run).toContain('const globalChannelSync = startGlobalChannelSync({');
        // A failure there must be caught: an unhandled rejection shuts the daemon down.
        expect(run).toContain('onChanged: (result) => { accountService.globalChannelsChanged(result.removed).catch((error) =>');
        expect(run).toContain('token: () => credentials.token,');
        expect(read('agentProfiles/daemonAccounts.ts')).toContain('const paths = [accountsPath(home), providersPath(home), globalAccountsPath(home)];');
    });
});
