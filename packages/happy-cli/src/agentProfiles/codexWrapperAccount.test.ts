import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCodexWrapperAccount, markCodexAccountRejected } from './codexWrapperAccount';
import { accountCodexHomePath, readAccountsFileV2, readSessionBindings, writeAccountsFile, writeSessionBinding } from './store';

function setup() {
    const root = mkdtempSync(join(tmpdir(), 'vh-b850b-wrap-'));
    const home = join(root, 'happy');
    const codexHome = join(root, 'codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), '[model_providers.llmhub]\nbase_url = "https://hub/v1"\nenv_key = "LLMHUB_API_KEY"\n');
    writeAccountsFile(home, {
        version: 2,
        accounts: {
            hub: { label: 'Hub', agent: 'codex', kind: 'codex-provider', createdAt: 1, provider: 'llmhub', key: { source: 'env', name: 'MY_HUB_KEY' }, models: ['kimi'] },
            gpt: { label: 'GPT', agent: 'codex', kind: 'codex-chatgpt', createdAt: 1 },
        },
        defaults: {},
    });
    return { root, home, codexHome };
}

describe('B-850b Codex wrapper account (IO)', () => {
    it('provider account: inherited provider keys leave the wrapper env; the env key is copied 0600 for the auth command', () => {
        const { home, codexHome } = setup();
        writeSessionBinding(home, 's1', { account: 'hub' });
        const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, LLMHUB_API_KEY: 'daemon-wide', MY_HUB_KEY: 'acct-key', OPENAI_API_KEY: 'x', PATH: '/bin' };
        const a = loadCodexWrapperAccount(home, 's1', undefined, env);
        expect(env.LLMHUB_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.MY_HUB_KEY).toBeUndefined();
        expect(env.PATH).toBe('/bin');
        expect(a).toMatchObject({ unavailable: false, profile: { id: 'hub', status: 'active', model: 'kimi' }, overrides: { modelProvider: 'vh-hub', env: {} } });
        const keyPath = (a.overrides.config!.model_providers as any)['vh-hub'].auth.args.at(-1);
        expect(readFileSync(keyPath, 'utf8').trim()).toBe('acct-key');
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(a)).not.toContain('acct-key');
        a.cleanup();
        expect(existsSync(keyPath)).toBe(false);
    });

    it('ChatGPT account: the overlay is synced and the app-server gets its CODEX_HOME', () => {
        const { home, codexHome } = setup();
        mkdirSync(accountCodexHomePath(home, 'gpt'), { recursive: true });
        writeFileSync(join(accountCodexHomePath(home, 'gpt'), 'auth.json'), '{}');
        const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
        const a = loadCodexWrapperAccount(home, 's2', 'gpt', env);
        expect(readSessionBindings(home).s2).toEqual({ account: 'gpt' });
        expect(a.overrides).toEqual({ env: { CODEX_HOME: accountCodexHomePath(home, 'gpt') }, modelProvider: 'openai' });
        expect(lstatSync(join(accountCodexHomePath(home, 'gpt'), 'sessions')).isSymbolicLink()).toBe(true);
        expect(env.CODEX_HOME).toBe(codexHome);
    });

    it('unbound session: env untouched; unusable binding: refused with a notice and keys still stripped', () => {
        const { home, codexHome } = setup();
        const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, LLMHUB_API_KEY: 'k' };
        expect(loadCodexWrapperAccount(home, 'free', undefined, env)).toMatchObject({ profile: null, unavailable: false });
        expect(env.LLMHUB_API_KEY).toBe('k');
        writeSessionBinding(home, 's3', { account: 'gpt' });
        const a = loadCodexWrapperAccount(home, 's3', undefined, env);
        expect(a).toMatchObject({ unavailable: true, profile: { reason: 'missing-secret' } });
        expect(a.notices[0]).toMatch(/will not fall back to the machine login/);
        expect(env.LLMHUB_API_KEY).toBeUndefined();
    });

    it('a 401 marks the account (ChatGPT → expired, API → invalid)', () => {
        const { home } = setup();
        expect(markCodexAccountRejected(home, 'gpt', 9)).toBe('expired');
        expect(markCodexAccountRejected(home, 'hub', 9)).toBe('invalid');
        expect(readAccountsFileV2(home).accounts.hub.check).toEqual({ status: 'invalid', at: 9, detail: 'rejected during a session' });
        expect(markCodexAccountRejected(home, 'nope')).toBeNull();
    });
});
