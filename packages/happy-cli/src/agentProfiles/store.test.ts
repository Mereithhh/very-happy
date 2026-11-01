import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    accountSecretPath,
    accountStatus,
    buildAgentProfilesState,
    legacyAccountsFromProviders,
    mergeAccounts,
    mergeSessionBindings,
    newAccountId,
    parseAccountsFile,
    readAccounts,
    readSessionBindings,
    sessionsBoundTo,
    writeAccountSecret,
    writeAccountsFile,
    writeSessionBinding,
    type SecretProbe,
} from './store';

// Fake credentials, assembled at runtime so secret scanners do not flag test literals.
const OAT = ['sk', 'ant', 'oat01', ''].join('-');

const probe = (files: string[] = [], env: Record<string, string> = {}): SecretProbe => ({ fileReadable: (p) => files.includes(p), env });

describe('B-850a account store', () => {
    it('parses v2 tolerantly: bad ids, unknown kinds and API accounts without URL/key are dropped', () => {
        const f = parseAccountsFile({
            accounts: {
                'org-a': { agent: 'claude', kind: 'claude-subscription', label: ' Org A ', createdAt: 5, expiresAt: 99 },
                hub: { agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://h/', key: { source: 'file', path: '~/k' }, models: ['m1', 3], contextWindows: { m1: 1000, m2: -1 } },
                nokey: { agent: 'claude', kind: 'claude-api', label: 'x', baseUrl: 'https://h' },
                'Bad Id': { agent: 'claude', kind: 'claude-subscription', label: 'x' },
                cx: { agent: 'codex', kind: 'codex-chatgpt', label: 'x' },
            },
            defaults: { claude: 'org-a', bogus: 3 },
        });
        expect(Object.keys(f.accounts)).toEqual(['org-a', 'hub']);
        expect(f.accounts['org-a'].label).toBe('Org A');
        expect(f.accounts.hub).toMatchObject({ baseUrl: 'https://h', models: ['m1'], contextWindows: { m1: 1000 } });
        expect(f.defaults).toEqual({ claude: 'org-a' });
        expect(parseAccountsFile('garbage')).toEqual({ version: 2, accounts: {}, defaults: {} });
    });

    it('v1 providers.json profiles become read-only legacy API accounts; a v2 id wins', () => {
        const legacy = legacyAccountsFromProviders({ profiles: { hub: { name: 'LLM Hub', baseUrl: 'https://h', apiKeyFile: '~/k', models: [{ id: 'kimi', contextWindow: 262144 }] } } });
        expect(legacy.hub).toMatchObject({ label: 'LLM Hub', kind: 'claude-api', key: { source: 'file', path: '~/k' }, models: ['kimi'], contextWindows: { kimi: 262144 }, legacy: true });
        const v2 = parseAccountsFile({ accounts: { hub: { agent: 'claude', kind: 'claude-subscription', label: 'mine' } } });
        expect(mergeAccounts(v2, legacy).accounts.hub.label).toBe('mine');
    });

    it('bindings: v1 applies only where v2 is silent; v2 null = explicit machine login', () => {
        const merged = mergeSessionBindings(
            { s2: { account: null }, s3: { account: 'org-a' }, bad: { account: 7 } },
            { s1: { profile: 'hub', model: 'kimi' }, s2: { profile: 'hub', model: 'kimi' } },
        );
        expect(merged).toEqual({ s1: { account: 'hub', model: 'kimi' }, s2: { account: null }, s3: { account: 'org-a' } });
        expect(sessionsBoundTo(merged, 'hub')).toEqual(['s1']);
    });

    it('new ids: ASCII slug, kind fallback for non-ASCII labels, unique', () => {
        expect(newAccountId('Org A', 'claude-subscription', [])).toBe('org-a');
        expect(newAccountId('组织 A', 'claude-subscription', [])).toBe('claude-sub');
        expect(newAccountId('组织', 'claude-subscription', ['claude-sub'])).toBe('claude-sub-2');
        expect(newAccountId('LLM hub', 'claude-api', ['llm-hub', 'llm-hub-2'])).toBe('llm-hub-3');
    });

    it('status: missing secret beats expiry beats the last check', () => {
        const home = '/h';
        const sub = parseAccountsFile({ accounts: { a: { agent: 'claude', kind: 'claude-subscription', label: 'A', expiresAt: 100, check: { status: 'ok', at: 1 } } } }).accounts.a;
        const secret = accountSecretPath(home, 'a');
        expect(accountStatus(home, 'a', sub, probe(), 50)).toEqual({ status: 'missing-secret' });
        expect(accountStatus(home, 'a', sub, probe([secret]), 50)).toEqual({ status: 'ok' });
        expect(accountStatus(home, 'a', sub, probe([secret]), 100)).toEqual({ status: 'expired' });
        const api = parseAccountsFile({ accounts: { h: { agent: 'claude', kind: 'claude-api', label: 'H', baseUrl: 'https://h', key: { source: 'env', name: 'HUB_KEY' } } } }).accounts.h;
        expect(accountStatus(home, 'h', api, probe(), 0).status).toBe('missing-secret');
        expect(accountStatus(home, 'h', api, probe([], { HUB_KEY: 'k' }), 0).status).toBe('unverified');
    });

    it('state: summaries carry no secret, only the key reference; defaults to removed accounts are dropped', () => {
        const file = parseAccountsFile({
            accounts: { h: { agent: 'claude', kind: 'claude-api', label: 'H', baseUrl: 'https://h', key: { source: 'file', path: '~/.config/k' }, createdAt: 2 } },
            defaults: { claude: 'gone' },
        });
        const state = buildAgentProfilesState('/h', file, probe(['/root/.config/k']), 10, 42);
        expect(state.daemonPid).toBe(42);
        expect(state.defaults).toEqual({});
        expect(state.accounts[0]).toMatchObject({ id: 'h', keySource: 'file', keyRef: '~/.config/k', baseUrl: 'https://h' });
    });

    it('files: 0600 registry without legacy entries, 0600 secret in a 0700 dir, binding round trip', () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-b850-store-'));
        writeFileSync(join(home, 'providers.json'), JSON.stringify({ profiles: { hub: { baseUrl: 'https://h', apiKeyFile: '/k' } } }));
        const all = readAccounts(home);
        expect(all.accounts.hub.legacy).toBe(true);
        all.accounts['org-a'] = { label: 'Org A', agent: 'claude', kind: 'claude-subscription', createdAt: 1 };
        writeAccountsFile(home, all);
        const raw = JSON.parse(readFileSync(join(home, 'accounts.json'), 'utf8'));
        expect(Object.keys(raw.accounts)).toEqual(['org-a']);
        expect(statSync(join(home, 'accounts.json')).mode & 0o777).toBe(0o600);
        writeAccountSecret(home, 'org-a', OAT + 'x\n');
        expect(statSync(accountSecretPath(home, 'org-a')).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, 'accounts', 'org-a')).mode & 0o777).toBe(0o700);
        expect(raw.accounts['org-a']).not.toHaveProperty('token');
        writeSessionBinding(home, 's1', { account: 'org-a' });
        writeSessionBinding(home, 's2', { account: null });
        expect(readSessionBindings(home)).toEqual({ s1: { account: 'org-a' }, s2: { account: null } });
        writeSessionBinding(home, 's1', undefined);
        expect(readSessionBindings(home)).toEqual({ s2: { account: null } });
        expect(() => accountSecretPath(home, '../x')).toThrow();
    });
});
