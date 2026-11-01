/**
 * B-850b: what a Codex wrapper runs on for its session's account binding.
 *
 *   codex-chatgpt  → the app-server runs with CODEX_HOME = the account's
 *                    overlay (codexHome.ts) and `modelProvider: 'openai'`.
 *   codex-provider → a per-thread provider override `vh-<id>` whose `auth`
 *                    command reads the key file (codexConfig.ts). The key is
 *                    never in an env: Codex's `exec_command` inherits the
 *                    app-server env, so `env_key` (B-847's drop-in) put the key
 *                    in every Codex shell — measured on 0.154.
 *
 * Bound sessions also drop every config.toml provider `env_key` (and
 * CODEX_API_KEY / OPENAI_API_KEY) from the wrapper env, so a daemon that still
 * carries one does not hand it to a session bound elsewhere. Unbound sessions
 * keep today's env (machine login / config.toml).
 *
 * As for Claude (Owner Q3): a binding that cannot be honoured never falls back
 * to the machine login — the wrapper refuses turns and says why.
 */
import type { SessionAgentProfile } from '@slopus/happy-wire';
import { accountProviderId, buildCodexProviderTable, type CodexProviderDef } from './codexConfig';
import { accountCodexHomePath, accountSecretPath, expandHome, type AccountsFile, type SessionAccountsFile } from './store';

export const CODEX_ALWAYS_STRIPPED_ENV_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

export type CodexAccountResolution =
    | { kind: 'machine' }
    | {
          kind: 'active';
          id: string;
          profile: SessionAgentProfile;
          /** Variables to drop from the wrapper env (inherited provider keys). */
          unset: string[];
          /** codex-chatgpt: run the app-server with this CODEX_HOME. */
          codexHome?: string;
          /** thread/start|resume|fork `modelProvider`. */
          modelProvider: string;
          /** Merged into the thread `config` (`model_providers.<modelProvider>`). */
          config?: Record<string, unknown>;
          /** The model the binding names (codex-provider default: the account's first model). */
          pinnedModel?: string;
          /** codex-provider: the models the account lists (the picker shows these). */
          models?: string[];
          /** env-sourced key: copy the value here (0600) and drop the variable from the wrapper env. */
          envKeyCopy?: { name: string; path: string };
      }
    | { kind: 'unavailable'; id: string; profile: SessionAgentProfile; unset: string[] };

export type CodexAccountDeps = {
    home: string;
    accounts: AccountsFile;
    bindings: SessionAccountsFile;
    providers: CodexProviderDef[];
    fileReadable: (path: string) => boolean;
    env: Record<string, string | undefined>;
    nodePath: string;
    envKeyCopyPath: (id: string) => string;
};

/** Pure: provider keys a bound session must not inherit. */
export function codexStrippedEnvKeys(providers: CodexProviderDef[]): string[] {
    return [...new Set([...CODEX_ALWAYS_STRIPPED_ENV_KEYS, ...providers.map((p) => p.envKey).filter((k): k is string => !!k)])];
}

/** Pure (all IO injected): the Codex session's account, or machine login. */
export function resolveCodexAccount(sessionId: string, deps: CodexAccountDeps): CodexAccountResolution {
    const binding = deps.bindings[sessionId];
    if (!binding || binding.account === null) return { kind: 'machine' };
    const id = binding.account;
    const unset = codexStrippedEnvKeys(deps.providers);
    const record = deps.accounts.accounts[id];
    const unavailable = (label: string, kind: string, reason: string): CodexAccountResolution => ({
        kind: 'unavailable', id, profile: { id, label, kind, status: 'unavailable', reason }, unset,
    });
    if (!record) return unavailable(id, 'unknown', 'missing');
    const { label, kind } = record;
    if (record.agent !== 'codex') return unavailable(label, kind, 'agent-mismatch');
    if (record.check?.status === 'expired' || record.check?.status === 'invalid') return unavailable(label, kind, record.check.status);
    if (kind === 'codex-chatgpt') {
        const codexHome = accountCodexHomePath(deps.home, id);
        if (!deps.fileReadable(`${codexHome}/auth.json`)) return unavailable(label, kind, 'missing-secret');
        return {
            kind: 'active', id, unset, codexHome, modelProvider: 'openai',
            profile: { id, label, kind, status: 'active', ...(binding.model ? { model: binding.model } : {}) },
            ...(binding.model ? { pinnedModel: binding.model } : {}),
        };
    }
    // codex-provider
    const base = record.provider ? deps.providers.find((p) => p.id === record.provider) : undefined;
    const baseUrl = record.baseUrl ?? base?.baseUrl;
    if (!baseUrl) return unavailable(label, kind, 'missing');
    const key = record.key;
    if (!key) return unavailable(label, kind, 'missing-secret');
    let keyPath: string;
    let envKeyCopy: { name: string; path: string } | undefined;
    if (key.source === 'env') {
        if (!deps.env[key.name]?.trim()) return unavailable(label, kind, 'missing-secret');
        keyPath = deps.envKeyCopyPath(id);
        envKeyCopy = { name: key.name, path: keyPath };
    } else {
        keyPath = key.source === 'stored' ? accountSecretPath(deps.home, id) : expandHome(key.path);
        if (!deps.fileReadable(keyPath)) return unavailable(label, kind, 'missing-secret');
    }
    const modelProvider = accountProviderId(id);
    const model = binding.model ?? record.models?.[0];
    return {
        kind: 'active', id, unset, modelProvider,
        profile: { id, label, kind, status: 'active', ...(model ? { model } : {}) },
        config: {
            model_providers: {
                [modelProvider]: buildCodexProviderTable({ base, label, baseUrl, wireApi: record.wireApi, nodePath: deps.nodePath, keyPath }),
            },
        },
        ...(model ? { pinnedModel: model } : {}),
        ...(record.models?.length ? { models: record.models } : {}),
        ...(envKeyCopy ? { envKeyCopy } : {}),
    };
}

/**
 * Pure: did this restart move the session to another account (or, on the same
 * account, another bound model)? `previous` is the server copy of
 * `metadata.agentProfile` (undefined = older wrapper = machine login). A
 * switch resumes the thread on the new account's model and clears the sticky
 * model / model intent (B-844c/d) — the old model rarely exists on the new
 * endpoint.
 */
export function codexAccountSwitched(previous: unknown, next: SessionAgentProfile | null): boolean {
    const prev = previous && typeof previous === 'object' ? previous as { id?: unknown; model?: unknown } : null;
    const prevId = typeof prev?.id === 'string' ? prev.id : null;
    if (prevId !== (next?.id ?? null)) return true;
    const prevModel = typeof prev?.model === 'string' ? prev.model : undefined;
    return !!next?.model && prevModel !== next.model;
}

/**
 * Pure: a failed resume / first turn after a switch whose error says the new
 * account rejected the history (encrypted reasoning from another org).
 */
export function isHistoryRejectedError(message: string): boolean {
    return /encrypted[_ ]content|could not be (decrypted|verified)|invalid_encrypted|reasoning item|organization.*(mismatch|does not match)/i.test(message);
}

/** Pure: a failure that says the account's credential was refused (mark it, tell the user). */
export function isCodexAuthRejection(message: string): boolean {
    return /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|refresh token (was already used|is invalid|expired)|token_expired|please (log|sign) ?in again/i.test(message);
}

type CatalogModel = {
    id: string; model: string; displayName: string; description: string; hidden: boolean;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
    defaultReasoningEffort: string; isDefault: boolean;
};

/**
 * Pure: what "default" runs on this account. The binding's model wins; an API
 * account then uses its first listed model, else the config's; a ChatGPT
 * account keeps the config's model only when its own catalog has it (the
 * machine config may pin a provider-only model), else the catalog default.
 */
export function codexAccountDefaultModel(
    account: { profile: SessionAgentProfile | null; pinnedModel?: string; models?: string[] },
    configured: string | null,
    catalog: Array<Pick<CatalogModel, 'model' | 'isDefault'>>,
): string | undefined {
    if (account.pinnedModel) return account.pinnedModel;
    if (account.models?.length) return account.models[0];
    if (account.profile?.kind === 'codex-chatgpt') {
        if (configured && catalog.some((m) => m.model === configured)) return configured;
        return catalog.find((m) => m.isDefault)?.model ?? configured ?? undefined;
    }
    return configured ?? catalog.find((m) => m.isDefault)?.model;
}

/**
 * Pure: an API account's models as picker entries. Codex's catalog describes
 * OpenAI models; an id it knows keeps its efforts, others get none (the
 * picker then hides the effort control) — the endpoint decides.
 */
export function accountModelsAsCatalog<T extends CatalogModel>(models: string[], catalog: T[]): CatalogModel[] {
    return models.map((id, index) => {
        const known = catalog.find((m) => m.model === id);
        return known
            ? { ...known, isDefault: index === 0 }
            : { id, model: id, displayName: id, description: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: '', isDefault: index === 0 };
    });
}
