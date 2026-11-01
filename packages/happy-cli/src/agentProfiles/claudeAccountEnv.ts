/**
 * B-850a: what a Claude wrapper runs on for its session's account binding.
 *
 * Injection (measured on Claude Code 2.1.304, spec §实测):
 *   - subscription → `CLAUDE_CODE_OAUTH_TOKEN` in the wrapper env. Claude Code
 *     strips it from every child it spawns: Bash tool, hooks, stdio MCP.
 *   - API          → `apiKeyHelper` in the `--settings` file the wrapper
 *     already generates; the key is never in any env. B-794 put it in
 *     `ANTHROPIC_AUTH_TOKEN`, which Bash, hooks and stdio MCP all inherit.
 *
 * A binding that cannot be honoured never falls back to the machine login
 * (Owner Q3): the wrapper gets a placeholder token that Claude rejects with
 * 401 (no fallback — FEASIBILITY E3), refuses turns, and reports why.
 */
import type { SessionAgentProfile } from '@slopus/happy-wire';
import {
    accountSecretPath,
    expandHome,
    type AccountRecord,
    type AccountsFile,
    type SessionAccountsFile,
} from './store';

/** Credentials / routing a bound session must not inherit from the daemon env. */
export const ACCOUNT_STRIPPED_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_NO_MODEL_FALLBACK',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_SCOPES',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * Claude rejects it with 401. Set on an unusable binding so nothing runs on
 * the machine login, and under every API account: apiKeyHelper outranks it
 * (measured), so the session is unaffected, but a `claude` started without
 * the helper settings fails instead of falling back to the machine login and
 * sending ITS token to the account's endpoint.
 */
export const UNAVAILABLE_PLACEHOLDER_TOKEN = 'vh-account-unavailable';

export type ClaudeAccountResolution =
    | { kind: 'machine' }
    | {
          kind: 'active';
          id: string;
          profile: SessionAgentProfile;
          /** Env to set on the wrapper (subscription: contains the token — never log). */
          env: Record<string, string>;
          unset: readonly string[];
          /** Merged into every `--settings` file the wrapper writes. */
          settings: Record<string, unknown>;
          /** API kinds: every model slot is pinned to it. */
          pinnedModel?: string;
          /** env-sourced key: copy the value here (0600) and drop the variable from the wrapper env. */
          envKeyCopy?: { name: string; path: string };
      }
    | {
          kind: 'unavailable';
          id: string;
          profile: SessionAgentProfile;
          env: Record<string, string>;
          unset: readonly string[];
      };

export type ClaudeAccountDeps = {
    home: string;
    accounts: AccountsFile;
    bindings: SessionAccountsFile;
    /** Probe: file readable and non-empty. */
    fileReadable: (path: string) => boolean;
    env: Record<string, string | undefined>;
    /** Absolute path of the node binary for the helper (process.execPath). */
    nodePath: string;
    /** Where an env-sourced key is copied for the helper. */
    envKeyCopyPath: (id: string) => string;
    readSecret: (path: string) => string;
    now: number;
};

/** Pure: shell-safe for both POSIX sh and cmd.exe inside double quotes. */
export function helperSafePath(path: string): boolean {
    return path.length > 0 && !/["$`\\\n\r%!]/.test(path.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/'));
}

/**
 * Pure: Claude Code runs `apiKeyHelper` through a shell and sends its stdout
 * as the key (x-api-key + Authorization: Bearer). Node is always there (it
 * runs the wrapper) and reads the file fresh every refresh, so rotating the
 * key file needs no restart.
 */
export function buildApiKeyHelper(nodePath: string, keyPath: string): string {
    if (!helperSafePath(keyPath) || !helperSafePath(nodePath)) throw new Error('unsupported characters in key path');
    return `"${nodePath}" -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').trim())" "${keyPath}"`;
}

/** Pure: model slots for an API account (B-794/B-794b semantics, no credential). */
export function buildApiModelEnv(record: AccountRecord, model: string | undefined): Record<string, string> {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: record.baseUrl ?? '', CLAUDE_CODE_OAUTH_TOKEN: UNAVAILABLE_PLACEHOLDER_TOKEN };
    if (!model) return env;
    const contextWindow = record.contextWindows?.[model];
    return {
        ...env,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_SMALL_FAST_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
        ...(contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) } : {}),
    };
}

function unavailable(id: string, label: string, kind: string, reason: string): ClaudeAccountResolution {
    return {
        kind: 'unavailable',
        id,
        profile: { id, label, kind, status: 'unavailable', reason },
        env: { CLAUDE_CODE_OAUTH_TOKEN: UNAVAILABLE_PLACEHOLDER_TOKEN },
        unset: ACCOUNT_STRIPPED_ENV_KEYS,
    };
}

/** The last check got a definite 401/403: re-login / fix the key before running again. */
function rejectedByLastCheck(record: AccountRecord): boolean {
    return record.check?.status === 'expired' || record.check?.status === 'invalid';
}

/** Pure (all IO injected): the session's account, or machine login. */
export function resolveClaudeAccount(sessionId: string, deps: ClaudeAccountDeps): ClaudeAccountResolution {
    const binding = deps.bindings[sessionId];
    if (!binding || binding.account === null) return { kind: 'machine' };
    const id = binding.account;
    const record = deps.accounts.accounts[id];
    if (!record) return unavailable(id, id, 'unknown', 'missing');
    const { label, kind } = record;
    if (kind === 'claude-subscription') {
        const path = accountSecretPath(deps.home, id);
        if (!deps.fileReadable(path)) return unavailable(id, label, kind, 'missing-secret');
        if (record.expiresAt !== undefined && record.expiresAt <= deps.now) return unavailable(id, label, kind, 'expired');
        if (rejectedByLastCheck(record)) return unavailable(id, label, kind, record.check!.status);
        const token = deps.readSecret(path).trim();
        if (!token) return unavailable(id, label, kind, 'missing-secret');
        return {
            kind: 'active',
            id,
            profile: { id, label, kind, status: 'active' },
            env: { CLAUDE_CODE_OAUTH_TOKEN: token },
            unset: ACCOUNT_STRIPPED_ENV_KEYS,
            settings: {},
        };
    }
    // claude-api
    const key = record.key;
    let keyPath: string;
    let envKeyCopy: { name: string; path: string } | undefined;
    if (!key) return unavailable(id, label, kind, 'missing-secret');
    if (key.source === 'env') {
        if (!deps.env[key.name]?.trim()) return unavailable(id, label, kind, 'missing-secret');
        keyPath = deps.envKeyCopyPath(id);
        envKeyCopy = { name: key.name, path: keyPath };
    } else {
        keyPath = key.source === 'stored' ? accountSecretPath(deps.home, id) : expandHome(key.path);
        if (!deps.fileReadable(keyPath)) return unavailable(id, label, kind, 'missing-secret');
    }
    if (rejectedByLastCheck(record)) return unavailable(id, label, kind, record.check!.status);
    let helper: string;
    try {
        helper = buildApiKeyHelper(deps.nodePath, keyPath);
    } catch {
        return unavailable(id, label, kind, 'missing-secret');
    }
    const model = binding.model ?? record.models?.[0];
    return {
        kind: 'active',
        id,
        profile: { id, label, kind, status: 'active', ...(model ? { model } : {}) },
        env: buildApiModelEnv(record, model),
        unset: ACCOUNT_STRIPPED_ENV_KEYS,
        settings: { apiKeyHelper: helper },
        ...(model ? { pinnedModel: model } : {}),
        ...(envKeyCopy ? { envKeyCopy } : {}),
    };
}

/** Mutates `env` in place: strip inherited credentials, then set the account's. */
export function applyAccountEnv(env: Record<string, string | undefined>, r: Exclude<ClaudeAccountResolution, { kind: 'machine' }>): void {
    for (const key of r.unset) delete env[key];
    Object.assign(env, r.env);
}

/**
 * Pure: keys in the user's own Claude settings that beat the injected
 * credential (Claude's precedence: settings `env` > process env; any
 * apiKeyHelper beats CLAUDE_CODE_OAUTH_TOKEN). The wrapper warns once.
 */
export function overridingUserSettings(userSettings: unknown, kind: string): string[] {
    if (!userSettings || typeof userSettings !== 'object') return [];
    const s = userSettings as { env?: unknown; apiKeyHelper?: unknown };
    const hits: string[] = [];
    if (kind === 'claude-subscription' && typeof s.apiKeyHelper === 'string' && s.apiKeyHelper) hits.push('apiKeyHelper');
    if (s.env && typeof s.env === 'object') {
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
            if (typeof (s.env as Record<string, unknown>)[key] === 'string') hits.push(`env.${key}`);
        }
    }
    return hits;
}
