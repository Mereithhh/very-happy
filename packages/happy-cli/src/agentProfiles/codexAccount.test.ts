import { describe, expect, it } from 'vitest';
import {
    accountModelsAsCatalog,
    codexAccountDefaultModel,
    codexAccountSwitched,
    codexStrippedEnvKeys,
    isCodexAuthRejection,
    isHistoryRejectedError,
    resolveCodexAccount,
    type CodexAccountDeps,
} from './codexAccount';
import { parseCodexProviders } from './codexConfig';
import { accountCodexHomePath, accountSecretPath, parseAccountsFile, type SessionAccountsFile } from './store';

const HOME = '/h';
const providers = parseCodexProviders('[model_providers.llmhub]\nname = "LLM Hub"\nbase_url = "https://hub/v1"\nenv_key = "LLMHUB_API_KEY"\n');
const accounts = parseAccountsFile({
    accounts: {
        gpt: { agent: 'codex', kind: 'codex-chatgpt', label: 'ChatGPT B' },
        hub: { agent: 'codex', kind: 'codex-provider', label: 'Hub', provider: 'llmhub', key: { source: 'file', path: '/keys/hub' }, models: ['kimi', 'ds'] },
        envhub: { agent: 'codex', kind: 'codex-provider', label: 'Env hub', baseUrl: 'https://own/v1', key: { source: 'env', name: 'LLMHUB_API_KEY' } },
        gone: { agent: 'codex', kind: 'codex-provider', label: 'Gone', provider: 'removed', key: { source: 'stored' } },
        bad: { agent: 'codex', kind: 'codex-provider', label: 'Bad', provider: 'llmhub', key: { source: 'file', path: '/keys/hub' }, check: { status: 'invalid', at: 1 } },
        claude: { agent: 'claude', kind: 'claude-subscription', label: 'C' },
    },
});
const deps = (bindings: SessionAccountsFile, files: string[] = [], env: Record<string, string> = {}): CodexAccountDeps => ({
    home: HOME, accounts, bindings, providers, fileReadable: (p) => files.includes(p), env, nodePath: '/node', envKeyCopyPath: (id) => `/tmp/key-${id}`,
});

describe('B-850b Codex account resolution', () => {
    it('unbound / machine binding → machine login, env untouched', () => {
        expect(resolveCodexAccount('s', deps({}))).toEqual({ kind: 'machine' });
        expect(resolveCodexAccount('s', deps({ s: { account: null } }))).toEqual({ kind: 'machine' });
    });

    it('ChatGPT account → its overlay home + the openai provider; without auth.json it is unavailable', () => {
        const auth = `${accountCodexHomePath(HOME, 'gpt')}/auth.json`;
        const r = resolveCodexAccount('s', deps({ s: { account: 'gpt' } }, [auth]));
        expect(r).toMatchObject({ kind: 'active', codexHome: accountCodexHomePath(HOME, 'gpt'), modelProvider: 'openai', profile: { id: 'gpt', kind: 'codex-chatgpt', status: 'active' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'gpt' } }))).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing-secret' } });
    });

    it('provider account → vh-<id> provider whose auth command reads the key file; the env_key leaves the env; first model pinned', () => {
        const r = resolveCodexAccount('s', deps({ s: { account: 'hub' } }, ['/keys/hub']));
        if (r.kind !== 'active') throw new Error(r.kind);
        expect(r.modelProvider).toBe('vh-hub');
        expect(r.unset).toEqual(expect.arrayContaining(['LLMHUB_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY']));
        const table = (r.config!.model_providers as Record<string, any>)['vh-hub'];
        expect(table).toMatchObject({ base_url: 'https://hub/v1', name: 'Hub' });
        expect(table.env_key).toBeUndefined();
        expect(table.auth.args.at(-1)).toBe('/keys/hub');
        expect(r).toMatchObject({ pinnedModel: 'kimi', models: ['kimi', 'ds'], profile: { model: 'kimi' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'hub', model: 'ds' } }, ['/keys/hub']))).toMatchObject({ pinnedModel: 'ds' });
    });

    it('env-sourced key is copied for the auth command; a missing variable / file / provider / rejected check is unavailable', () => {
        expect(resolveCodexAccount('s', deps({ s: { account: 'envhub' } }, [], { LLMHUB_API_KEY: 'k' }))).toMatchObject({ kind: 'active', envKeyCopy: { name: 'LLMHUB_API_KEY', path: '/tmp/key-envhub' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'envhub' } }))).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing-secret' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'hub' } }))).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing-secret' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'gone' } }, [accountSecretPath(HOME, 'gone')]))).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'bad' } }, ['/keys/hub']))).toMatchObject({ kind: 'unavailable', profile: { reason: 'invalid' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'nope' } }))).toMatchObject({ kind: 'unavailable', profile: { reason: 'missing' } });
        expect(resolveCodexAccount('s', deps({ s: { account: 'claude' } }))).toMatchObject({ kind: 'unavailable', profile: { reason: 'agent-mismatch' } });
    });

    it('a bound session never inherits any provider key, even unavailable', () => {
        expect(codexStrippedEnvKeys(providers)).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY', 'LLMHUB_API_KEY']);
        expect(resolveCodexAccount('s', deps({ s: { account: 'nope' } }))).toMatchObject({ unset: expect.arrayContaining(['LLMHUB_API_KEY']) });
    });

    it('switch detection: previous metadata.agentProfile id vs the new one (absent = machine)', () => {
        expect(codexAccountSwitched(undefined, null)).toBe(false);
        expect(codexAccountSwitched(null, { id: 'hub', label: 'h', kind: 'codex-provider', status: 'active' })).toBe(true);
        expect(codexAccountSwitched({ id: 'hub' }, { id: 'hub', label: 'h', kind: 'codex-provider', status: 'active' })).toBe(false);
        expect(codexAccountSwitched({ id: 'gpt' }, null)).toBe(true);
        expect(codexAccountSwitched({ id: 'hub', model: 'kimi' }, { id: 'hub', label: 'h', kind: 'codex-provider', status: 'active', model: 'ds' })).toBe(true);
        expect(codexAccountSwitched({ id: 'hub', model: 'kimi' }, { id: 'hub', label: 'h', kind: 'codex-provider', status: 'active', model: 'kimi' })).toBe(false);
        expect(codexAccountSwitched({ id: 'gpt' }, { id: 'gpt', label: 'g', kind: 'codex-chatgpt', status: 'active' })).toBe(false);
    });

    it('default model per account; API models become the picker; error classifiers', () => {
        const catalog = [{ model: 'gpt-6.1-sol', isDefault: true }, { model: 'gpt-5.6-sol', isDefault: false }];
        expect(codexAccountDefaultModel({ profile: null, pinnedModel: 'x' }, 'y', catalog)).toBe('x');
        expect(codexAccountDefaultModel({ profile: null, models: ['kimi'] }, 'y', catalog)).toBe('kimi');
        const gpt = { id: 'g', label: 'g', kind: 'codex-chatgpt', status: 'active' };
        expect(codexAccountDefaultModel({ profile: gpt }, 'gpt-5.6-sol', catalog)).toBe('gpt-5.6-sol');
        expect(codexAccountDefaultModel({ profile: gpt }, 'deepseek-v4', catalog)).toBe('gpt-6.1-sol');
        const full = [{ id: 'a', model: 'gpt-5.6-sol', displayName: 'GPT', description: 'd', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'high', isDefault: false }];
        expect(accountModelsAsCatalog(['kimi', 'gpt-5.6-sol'], full)).toEqual([
            expect.objectContaining({ model: 'kimi', displayName: 'kimi', supportedReasoningEfforts: [], isDefault: true }),
            expect.objectContaining({ model: 'gpt-5.6-sol', displayName: 'GPT', isDefault: false }),
        ]);
        expect(isHistoryRejectedError('400: The encrypted content for item rs_1 could not be verified.')).toBe(true);
        expect(isHistoryRejectedError('rate limited')).toBe(false);
        expect(isCodexAuthRejection('unexpected status 401 Unauthorized')).toBe(true);
        expect(isCodexAuthRejection('Failed to refresh token: refresh token was already used')).toBe(true);
        expect(isCodexAuthRejection('stream disconnected')).toBe(false);
    });
});
