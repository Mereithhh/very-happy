/**
 * B-794: per-session Claude provider (base URL + model) binding.
 *
 * Machine-local, file-backed — never synced, never in session metadata:
 *
 *   $HAPPY_HOME_DIR/providers.json         { profiles: { <id>: { name?, baseUrl, apiKeyFile, models? } } }
 *   $HAPPY_HOME_DIR/session-providers.json { <happySessionId>: { profile, model } }
 *
 * The session's wrapper reads its own binding once at startup (runClaude) and
 * rewrites ITS process env before any Claude Code child is spawned, so only the
 * bound session changes; every other wrapper is a separate process and keeps
 * exactly today's env. The key is read from `apiKeyFile` at that moment and is
 * never logged or persisted anywhere else.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ProviderProfile = {
    name?: string;
    baseUrl: string;
    apiKeyFile: string;
    models?: string[];
};

export type ProvidersFile = { profiles: Record<string, ProviderProfile> };
export type SessionProviderBinding = { profile: string; model: string };
export type SessionProvidersFile = Record<string, SessionProviderBinding>;

/** Env a bound session's Claude Code must not inherit: they would beat or confuse the hub token. */
export const PROVIDER_STRIPPED_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_SCOPES',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

export type ResolvedProvider = {
    profile: string;
    model: string;
    baseUrl: string;
    /** Env to set on the wrapper process (contains the token — never log). */
    env: Record<string, string>;
    /** Env keys to delete from the wrapper process. */
    unset: readonly string[];
};

export function providersPath(happyHomeDir: string): string {
    return join(happyHomeDir, 'providers.json');
}

export function sessionProvidersPath(happyHomeDir: string): string {
    return join(happyHomeDir, 'session-providers.json');
}

export function expandHome(path: string, home: string = homedir()): string {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function readJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseProvidersFile(raw: unknown): ProvidersFile {
    const profiles: Record<string, ProviderProfile> = {};
    const src = raw && typeof raw === 'object' ? (raw as { profiles?: unknown }).profiles : undefined;
    if (src && typeof src === 'object') {
        for (const [id, p] of Object.entries(src as Record<string, unknown>)) {
            if (!p || typeof p !== 'object') continue;
            const { name, baseUrl, apiKeyFile, models } = p as Record<string, unknown>;
            if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl) || typeof apiKeyFile !== 'string' || !apiKeyFile) continue;
            profiles[id] = {
                ...(typeof name === 'string' ? { name } : {}),
                baseUrl: baseUrl.replace(/\/+$/, ''),
                apiKeyFile,
                ...(Array.isArray(models) ? { models: models.filter((m): m is string => typeof m === 'string') } : {}),
            };
        }
    }
    return { profiles };
}

export function parseSessionProvidersFile(raw: unknown): SessionProvidersFile {
    const out: SessionProvidersFile = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [sessionId, b] of Object.entries(raw as Record<string, unknown>)) {
        if (!b || typeof b !== 'object') continue;
        const { profile, model } = b as Record<string, unknown>;
        if (typeof profile === 'string' && profile && typeof model === 'string' && model) out[sessionId] = { profile, model };
    }
    return out;
}

export function readProviders(happyHomeDir: string): ProvidersFile {
    return parseProvidersFile(readJson(providersPath(happyHomeDir)));
}

export function readSessionProviders(happyHomeDir: string): SessionProvidersFile {
    return parseSessionProvidersFile(readJson(sessionProvidersPath(happyHomeDir)));
}

/**
 * Pure: the env a bound session runs with. Every Claude model slot (main,
 * opus/sonnet/haiku aliases, subagents, background small-fast calls) points
 * at the bound model so no request falls back to an Anthropic model id the
 * hub would route elsewhere.
 */
export function buildProviderEnv(profile: ProviderProfile, model: string, token: string): Record<string, string> {
    return {
        ANTHROPIC_BASE_URL: profile.baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_SMALL_FAST_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
    };
}

/**
 * The binding for one session, or null when it has none (the unchanged path).
 * Throws on a binding that cannot be honoured (unknown profile, unreadable
 * key) — the caller must fail loudly rather than silently run on the default
 * provider the user explicitly moved away from.
 */
export function resolveSessionProvider(
    sessionId: string,
    deps: {
        providers: ProvidersFile;
        bindings: SessionProvidersFile;
        readKey: (path: string) => string;
    },
): ResolvedProvider | null {
    const binding = deps.bindings[sessionId];
    if (!binding) return null;
    const profile = deps.providers.profiles[binding.profile];
    if (!profile) throw new Error(`provider profile "${binding.profile}" is not defined in providers.json`);
    const token = deps.readKey(profile.apiKeyFile).trim();
    if (!token) throw new Error(`provider profile "${binding.profile}": api key file is empty`);
    return {
        profile: binding.profile,
        model: binding.model,
        baseUrl: profile.baseUrl,
        env: buildProviderEnv(profile, binding.model, token),
        unset: PROVIDER_STRIPPED_ENV_KEYS,
    };
}

export function loadSessionProvider(happyHomeDir: string, sessionId: string): ResolvedProvider | null {
    const bindings = readSessionProviders(happyHomeDir);
    if (!bindings[sessionId]) return null;
    return resolveSessionProvider(sessionId, {
        providers: readProviders(happyHomeDir),
        bindings,
        readKey: (p) => readFileSync(expandHome(p), 'utf8'),
    });
}

/** Mutates `env` in place: strip inherited credentials, then set the provider's. */
export function applyProviderEnv(env: Record<string, string | undefined>, provider: ResolvedProvider): void {
    for (const key of provider.unset) delete env[key];
    Object.assign(env, provider.env);
}

/** Pure: next bindings file after `set` (binding) or clear (null). */
export function updateBindings(
    current: SessionProvidersFile,
    sessionId: string,
    binding: SessionProviderBinding | null,
): SessionProvidersFile {
    const next = { ...current };
    if (binding) next[sessionId] = binding;
    else delete next[sessionId];
    return next;
}

export function writeSessionProviders(happyHomeDir: string, bindings: SessionProvidersFile): void {
    const path = sessionProvidersPath(happyHomeDir);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}
