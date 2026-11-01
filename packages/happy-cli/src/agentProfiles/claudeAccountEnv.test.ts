import { describe, expect, it } from 'vitest';
import {
    ACCOUNT_STRIPPED_ENV_KEYS,
    UNAVAILABLE_PLACEHOLDER_TOKEN,
    applyAccountEnv,
    buildApiKeyHelper,
    overridingUserSettings,
    resolveClaudeAccount,
    type ClaudeAccountDeps,
} from './claudeAccountEnv';
import { accountSecretPath, parseAccountsFile, type SessionAccountsFile } from './store';

// Fake credentials, assembled at runtime so secret scanners do not flag test literals.
const OAT = ['sk', 'ant', 'oat01', ''].join('-');
const API = ['sk', 'ant', 'api03', ''].join('-');

const HOME = '/vh';
const accounts = parseAccountsFile({
    accounts: {
        'org-a': { agent: 'claude', kind: 'claude-subscription', label: 'Org A', expiresAt: 1_000 },
        hub: { agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://hub', key: { source: 'file', path: '/keys/hub' }, models: ['kimi', 'ds'], contextWindows: { kimi: 262144 } },
        envhub: { agent: 'claude', kind: 'claude-api', label: 'Env hub', baseUrl: 'https://hub', key: { source: 'env', name: 'HUB_KEY' } },
        pasted: { agent: 'claude', kind: 'claude-api', label: 'Pasted', baseUrl: 'https://api.anthropic.com', key: { source: 'stored' } },
        bad: { agent: 'claude', kind: 'claude-api', label: 'Bad', baseUrl: 'https://hub', key: { source: 'file', path: '/keys/hub' }, check: { status: 'invalid', at: 1 } },
        revoked: { agent: 'claude', kind: 'claude-subscription', label: 'Revoked', check: { status: 'expired', at: 1 } },
    },
});

function deps(bindings: SessionAccountsFile, over: Partial<ClaudeAccountDeps> = {}): ClaudeAccountDeps {
    const files: Record<string, string> = {
        [accountSecretPath(HOME, 'org-a')]: OAT + 'ORGA\n',
        [accountSecretPath(HOME, 'pasted')]: API + 'P',
        [accountSecretPath(HOME, 'revoked')]: OAT + 'R',
        '/keys/hub': 'hub-key',
    };
    return {
        home: HOME,
        accounts,
        bindings,
        fileReadable: (p) => !!files[p],
        env: { HUB_KEY: 'hub-env-key' },
        nodePath: '/usr/bin/node',
        envKeyCopyPath: (id) => `/vh/tmp/accounts/key-1-${id}`,
        readSecret: (p) => files[p] ?? '',
        now: 500,
        ...over,
    };
}

const allValues = (o: Record<string, unknown>) => JSON.stringify(o);

describe('B-850a Claude account resolution', () => {
    it('unbound or explicitly machine-bound sessions keep today\'s env (no read, no change)', () => {
        expect(resolveClaudeAccount('s', deps({}))).toEqual({ kind: 'machine' });
        expect(resolveClaudeAccount('s', deps({ s: { account: null } }))).toEqual({ kind: 'machine' });
    });

    it('subscription: token only in CLAUDE_CODE_OAUTH_TOKEN, never ANTHROPIC_AUTH_TOKEN; every inherited credential stripped', () => {
        const r = resolveClaudeAccount('s', deps({ s: { account: 'org-a' } }));
        expect(r.kind).toBe('active');
        if (r.kind !== 'active') return;
        expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAT + 'ORGA' });
        expect(r.settings).toEqual({});
        expect(r.profile).toEqual({ id: 'org-a', label: 'Org A', kind: 'claude-subscription', status: 'active' });
        const env: Record<string, string | undefined> = { ANTHROPIC_AUTH_TOKEN: 'daemon', ANTHROPIC_BASE_URL: 'https://hub', ANTHROPIC_API_KEY: 'x', PATH: '/bin' };
        applyAccountEnv(env, r);
        expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: OAT + 'ORGA' });
    });

    it('B-794 leak fixed: an API key is never in any env — only an apiKeyHelper that reads the file', () => {
        const r = resolveClaudeAccount('s', deps({ s: { account: 'hub', model: 'kimi' } }));
        if (r.kind !== 'active') throw new Error(r.kind);
        expect(allValues(r.env)).not.toContain('hub-key');
        expect(r.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        // A claude started without the helper must 401, not use the machine login against this endpoint.
        expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(UNAVAILABLE_PLACEHOLDER_TOKEN);
        expect(r.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://hub', ANTHROPIC_MODEL: 'kimi', CLAUDE_CODE_SUBAGENT_MODEL: 'kimi', CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144' });
        expect(r.settings.apiKeyHelper).toBe(buildApiKeyHelper('/usr/bin/node', '/keys/hub'));
        expect(String(r.settings.apiKeyHelper)).not.toContain('hub-key');
        expect(r.pinnedModel).toBe('kimi');
        expect(r.profile.model).toBe('kimi');
        expect(r.unset).toEqual(ACCOUNT_STRIPPED_ENV_KEYS);
        expect(ACCOUNT_STRIPPED_ENV_KEYS).toContain('ANTHROPIC_AUTH_TOKEN');
    });

    it('API without a bound model defaults to the first; with no models nothing is pinned', () => {
        const first = resolveClaudeAccount('s', deps({ s: { account: 'hub' } }));
        expect(first.kind === 'active' && first.pinnedModel).toBe('kimi');
        const none = resolveClaudeAccount('s', deps({ s: { account: 'pasted' } }));
        if (none.kind !== 'active') throw new Error(none.kind);
        expect(none.pinnedModel).toBeUndefined();
        expect(none.env).toEqual({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: UNAVAILABLE_PLACEHOLDER_TOKEN });
        expect(String(none.settings.apiKeyHelper)).toContain(accountSecretPath(HOME, 'pasted'));
    });

    it('env-sourced key: helper reads a private copy, and the variable is marked for removal', () => {
        const r = resolveClaudeAccount('s', deps({ s: { account: 'envhub' } }));
        if (r.kind !== 'active') throw new Error(r.kind);
        expect(r.envKeyCopy).toEqual({ name: 'HUB_KEY', path: '/vh/tmp/accounts/key-1-envhub' });
        expect(String(r.settings.apiKeyHelper)).toContain('/vh/tmp/accounts/key-1-envhub');
    });

    it('never falls back: missing / no secret / expired / rejected → unavailable with a 401 placeholder', () => {
        const cases: Array<[SessionAccountsFile, Partial<ClaudeAccountDeps>, string]> = [
            [{ s: { account: 'gone' } }, {}, 'missing'],
            [{ s: { account: 'org-a' } }, { fileReadable: () => false }, 'missing-secret'],
            [{ s: { account: 'org-a' } }, { now: 1_000 }, 'expired'],
            [{ s: { account: 'revoked' } }, {}, 'expired'],
            [{ s: { account: 'bad' } }, {}, 'invalid'],
            [{ s: { account: 'envhub' } }, { env: {} }, 'missing-secret'],
            [{ s: { account: 'hub' } }, { fileReadable: () => false }, 'missing-secret'],
        ];
        for (const [bindings, over, reason] of cases) {
            const r = resolveClaudeAccount('s', deps(bindings, over));
            expect(r.kind, reason).toBe('unavailable');
            if (r.kind !== 'unavailable') continue;
            expect(r.profile.reason).toBe(reason);
            expect(r.profile.status).toBe('unavailable');
            expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: UNAVAILABLE_PLACEHOLDER_TOKEN });
            const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'machine', CLAUDE_CODE_OAUTH_TOKEN: 'machine' };
            applyAccountEnv(env, r);
            expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: UNAVAILABLE_PLACEHOLDER_TOKEN });
        }
    });

    it('helper refuses shell-active characters in paths', () => {
        expect(() => buildApiKeyHelper('/usr/bin/node', '/k/$(id)')).toThrow();
        expect(() => buildApiKeyHelper('/usr/bin/node', '/k/"x')).toThrow();
        expect(buildApiKeyHelper('C:\\node\\node.exe', 'C:\\keys\\hub')).toContain('"C:\\keys\\hub"');
        const unsafe = resolveClaudeAccount('s', deps({ s: { account: 'hub' } }, { home: HOME }));
        expect(unsafe.kind).toBe('active');
    });

    it('flags user settings that would beat the account', () => {
        expect(overridingUserSettings({ apiKeyHelper: 'x', env: { ANTHROPIC_BASE_URL: 'u', OTHER: '1' } }, 'claude-subscription')).toEqual(['apiKeyHelper', 'env.ANTHROPIC_BASE_URL']);
        expect(overridingUserSettings({ apiKeyHelper: 'x' }, 'claude-api')).toEqual([]);
        expect(overridingUserSettings(undefined, 'claude-api')).toEqual([]);
    });
});
