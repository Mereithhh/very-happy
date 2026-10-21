/**
 * B-688 Codex adapter — `${CODEX_HOME:-~/.codex}/config.toml` (user scope:
 * project `.codex/config.toml` ignores model_provider/model_providers).
 * Owned keys: top-level `model`, `model_provider`, and inside
 * `[model_providers.<id>]` only name / base_url / wire_api / env_key /
 * experimental_bearer_token. Other keys of that table (http_headers,
 * query_params, auth, …), other providers, comments and layout are kept by the
 * line editor and proven unchanged by verifyTomlEdit.
 * Verified against openai/codex codex-rs (model_provider_info.rs, config docs)
 * and codex-cli 0.154.0: `wire_api` accepts only "responses".
 */
import { join } from 'node:path';
import { ModelConfigError } from '../fileStore';
import { collectSecretValues, maskSecret } from '../secrets';
import { editToml, parseToml, type TomlEdit } from '../tomlEdit';
import type { CodexPatch, ConfigWarning, FileSet, HarnessAdapter, HarnessContext, HarnessCurrent, HarnessPlan, ModelConfigPatch, SecretView } from '../types';
import { baseUrlWarnings, fail, normalizeBaseUrl, normalizeModelId, normalizeProviderId, normalizeSecret } from '../validate';
import { getPath, uniq } from './common';

const ROLE = 'config';
/** Built-in provider ids codex refuses to redefine. */
export const CODEX_RESERVED_PROVIDERS = ['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime', 'oss'] as const;

export function codexConfigPath(ctx: HarnessContext): string {
    const dir = ctx.env.CODEX_HOME?.trim() || join(ctx.home, '.codex');
    return join(dir, 'config.toml');
}

type Doc = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function providersOf(doc: Doc): Record<string, Doc> {
    const table = doc.model_providers;
    if (!table || typeof table !== 'object' || Array.isArray(table)) return {};
    return Object.fromEntries(Object.entries(table as Record<string, unknown>).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) as Record<string, Doc>;
}

function secretView(provider: Doc | undefined, ctx: HarnessContext): SecretView {
    if (!provider) return { mode: 'none' };
    const token = str(provider.experimental_bearer_token);
    if (token) return { mode: 'literal', masked: maskSecret(token) };
    const envKey = str(provider.env_key);
    if (envKey) return { mode: 'env', envName: envKey, envPresent: !!ctx.env[envKey] };
    if (provider.auth && typeof provider.auth === 'object') return { mode: 'command' };
    return { mode: 'none' };
}

function selectProvider(doc: Doc, requested?: string): string | null {
    const providers = providersOf(doc);
    if (requested) return requested;
    const active = str(doc.model_provider);
    if (active && providers[active]) return active;
    return Object.keys(providers)[0] ?? null;
}

function currentOf(doc: Doc, providerId: string | null, ctx: HarnessContext): HarnessCurrent {
    const provider = providerId ? providersOf(doc)[providerId] : undefined;
    const activeProvider = str(doc.model_provider);
    return {
        providerId,
        providerName: str(provider?.name),
        baseUrl: str(provider?.base_url),
        apiKey: secretView(provider, ctx),
        model: str(doc.model),
        activeProvider,
        active: !!providerId && activeProvider === providerId,
    };
}

function warningsOf(doc: Doc, current: HarnessCurrent): ConfigWarning[] {
    const out: ConfigWarning[] = [...baseUrlWarnings(current.baseUrl, 'openai')];
    const provider = current.providerId ? providersOf(doc)[current.providerId] : undefined;
    if (provider && str(provider.wire_api) && provider.wire_api !== 'responses') {
        out.push({ code: 'wire-api-unsupported', message: `wire_api = "${String(provider.wire_api)}" is rejected by current Codex; only "responses" is supported.` });
    }
    if (current.apiKey?.mode === 'env' && !current.apiKey.envPresent) {
        out.push({ code: 'env-missing', message: `${current.apiKey.envName} is not set in the daemon's environment, so sessions will not get a key.` });
    }
    const active = current.activeProvider;
    if (active && !(CODEX_RESERVED_PROVIDERS as readonly string[]).includes(active) && !providersOf(doc)[active]) {
        out.push({ code: 'active-provider-missing', message: `model_provider = "${active}" has no [model_providers.${active}] table.` });
    }
    return out;
}

function parsePatch(raw: ModelConfigPatch) {
    const p = raw as CodexPatch;
    if (p.activate !== undefined && typeof p.activate !== 'boolean') fail('invalid-input', 'activate must be a boolean');
    if (p.providerName !== undefined && (typeof p.providerName !== 'string' || p.providerName.length > 120 || /[\u0000-\u001f]/.test(p.providerName))) {
        fail('invalid-input', 'providerName must be a short single-line string');
    }
    return {
        providerId: normalizeProviderId(p.providerId, CODEX_RESERVED_PROVIDERS),
        providerName: p.providerName?.trim(),
        baseUrl: normalizeBaseUrl(p.baseUrl),
        apiKey: normalizeSecret(p.apiKey),
        model: normalizeModelId(p.model),
        activate: p.activate,
    };
}

export const codexAdapter: HarnessAdapter = {
    id: 'codex',
    binary: 'codex',
    files: ctx => [{ role: ROLE, path: codexConfigPath(ctx) }],
    view(files: FileSet, ctx: HarnessContext, opts) {
        const doc = parseToml(files[ROLE].content);
        const current = currentOf(doc, selectProvider(doc, opts.providerId), ctx);
        return { current, providers: Object.keys(providersOf(doc)), pickerModels: uniq([current.model]), warnings: warningsOf(doc, current) };
    },
    plan(files: FileSet, raw: ModelConfigPatch, ctx: HarnessContext): HarnessPlan {
        const patch = parsePatch(raw);
        const original = files[ROLE].content;
        const before = parseToml(original);
        const existing = providersOf(before)[patch.providerId];
        const table = ['model_providers', patch.providerId];
        const edits: TomlEdit[] = [];
        const secrets: string[] = [];
        if (!existing && !patch.baseUrl) fail('invalid-input', 'A new provider needs a base URL');
        const name = patch.providerName || str(existing?.name) || patch.providerId;
        if (!existing || (patch.providerName && patch.providerName !== existing.name) || !str(existing.name)) edits.push({ table, key: 'name', value: name });
        if (patch.baseUrl !== undefined) {
            if (patch.baseUrl === null && existing) fail('invalid-input', 'A provider needs a base URL; remove the provider instead');
            edits.push({ table, key: 'base_url', value: patch.baseUrl });
        }
        if (!existing || (str(existing.wire_api) && existing.wire_api !== 'responses')) edits.push({ table, key: 'wire_api', value: 'responses' });
        switch (patch.apiKey.mode) {
            case 'literal':
                edits.push({ table, key: 'experimental_bearer_token', value: patch.apiKey.value }, { table, key: 'env_key', value: null });
                secrets.push(patch.apiKey.value);
                break;
            case 'env':
                edits.push({ table, key: 'env_key', value: patch.apiKey.name }, { table, key: 'experimental_bearer_token', value: null });
                break;
            case 'clear':
                edits.push({ table, key: 'env_key', value: null }, { table, key: 'experimental_bearer_token', value: null });
                break;
            case 'keep':
                break;
        }
        if (patch.model !== undefined) edits.push({ table: [], key: 'model', value: patch.model });
        if (patch.activate === true) edits.push({ table: [], key: 'model_provider', value: patch.providerId });
        if (patch.activate === false && str(before.model_provider) === patch.providerId) edits.push({ table: [], key: 'model_provider', value: null });
        // Drop no-op edits so an unchanged form produces no diff at all.
        const effective = edits.filter(e => 'removeTable' in e || getPath(before, [...e.table, e.key]) !== (e.value ?? undefined));
        const content = effective.length ? editToml(original, effective) : undefined;
        const after = content === undefined ? before : parseToml(content);
        const current = currentOf(after, patch.providerId, ctx);
        const changedKeys = effective.map(e => [...e.table, 'removeTable' in e ? '*' : e.key].join('.'));
        return { contents: { [ROLE]: content }, warnings: warningsOf(after, current), changedKeys, secrets };
    },
    secretsIn(_role, content) {
        try {
            return collectSecretValues(parseToml(content));
        } catch (error) {
            if (error instanceof ModelConfigError) return new Set();
            throw error;
        }
    },
};
