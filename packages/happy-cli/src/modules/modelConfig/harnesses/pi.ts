/**
 * B-688 pi adapter — `${PI_CODING_AGENT_DIR:-~/.pi/agent}/`:
 *   models.json   → providers.<id>.{baseUrl, api, apiKey, models[]} — and
 *                   models[].contextWindow (B-727) — (owned
 *                   inside the chosen provider; headers/compat/modelOverrides
 *                   and other providers are kept)
 *   settings.json → defaultProvider / defaultModel (owned)
 * apiKey semantics (pi ≥ 0.77): `$NAME` / `${NAME}` reads an env var, `!cmd`
 * runs a command, anything else is literal — so a literal starting with `$`
 * or `!` is refused, and env mode writes `${NAME}`. Verified against
 * earendil-works/pi packages/coding-agent docs/models.md and pi 1.1.0.
 * pi accepts comments in models.json; Very Happy edits strict JSON only and
 * refuses a commented file instead of dropping the comments.
 */
import { join } from 'node:path';
import { childObject, parseJsonObject, setOrDelete, stringifyLike, type JsonObject } from '../jsonEdit';
import { collectSecretValues, maskSecret } from '../secrets';
import type { ConfigWarning, FileSet, HarnessAdapter, HarnessContext, HarnessCurrent, HarnessPlan, ModelConfigPatch, PiPatch, SecretView } from '../types';
import { baseUrlWarnings, fail, normalizeBaseUrl, normalizeContextWindows, normalizeModelId, normalizeModelList, normalizeProviderId, normalizeSecret } from '../validate';
import { changedPaths, uniq } from './common';

const MODELS = 'models';
const SETTINGS = 'settings';
export const PI_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'] as const;
const ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

export function piAgentDir(ctx: HarnessContext): string {
    return ctx.env.PI_CODING_AGENT_DIR?.trim() || join(ctx.home, '.pi', 'agent');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function providersOf(models: JsonObject): Record<string, JsonObject> {
    const p = models.providers;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    return Object.fromEntries(Object.entries(p as JsonObject).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) as Record<string, JsonObject>;
}

function modelIds(provider: JsonObject | undefined): string[] {
    const list = provider?.models;
    return Array.isArray(list) ? list.flatMap(m => (m && typeof m === 'object' && typeof (m as JsonObject).id === 'string' ? [(m as JsonObject).id as string] : [])) : [];
}

/** B-727: explicit `contextWindow` per model; pi assumes 128000 for the rest. */
function contextWindowsOf(provider: JsonObject | undefined): Record<string, number> {
    const list = provider?.models;
    if (!Array.isArray(list)) return {};
    const out: Record<string, number> = {};
    for (const m of list) {
        const entry = m && typeof m === 'object' ? m as JsonObject : null;
        if (typeof entry?.id === 'string' && typeof entry.contextWindow === 'number' && entry.contextWindow > 0) out[entry.id] = entry.contextWindow;
    }
    return out;
}

function secretView(provider: JsonObject | undefined, ctx: HarnessContext): SecretView {
    const key = str(provider?.apiKey);
    if (!key) return { mode: 'none' };
    const ref = ENV_REF.exec(key.trim());
    if (ref) return { mode: 'env', envName: ref[1], envPresent: !!ctx.env[ref[1]] };
    if (key.trim().startsWith('!')) return { mode: 'command' };
    return { mode: 'literal', masked: maskSecret(key) };
}

function currentOf(models: JsonObject, settings: JsonObject, providerId: string | null, ctx: HarnessContext): HarnessCurrent {
    const provider = providerId ? providersOf(models)[providerId] : undefined;
    const activeProvider = str(settings.defaultProvider);
    return {
        providerId,
        baseUrl: str(provider?.baseUrl),
        api: str(provider?.api),
        apiKey: secretView(provider, ctx),
        models: modelIds(provider),
        contextWindows: contextWindowsOf(provider),
        activeProvider,
        defaultModel: str(settings.defaultModel),
        active: !!providerId && activeProvider === providerId,
    };
}

/** pi-acp publishes models as `<provider>/<id>`; the composer picker uses the same keys. */
function pickerModelsOf(models: JsonObject): string[] {
    return uniq(Object.entries(providersOf(models)).flatMap(([id, p]) => modelIds(p).map(m => `${id}/${m}`)));
}

function warningsOf(settings: JsonObject, current: HarnessCurrent): ConfigWarning[] {
    const out: ConfigWarning[] = [...baseUrlWarnings(current.baseUrl, current.api === 'anthropic-messages' ? 'anthropic' : 'openai')]
        // pi's anthropic-messages baseUrl is the root (like Claude Code), so the /v1 hint does not apply.
        .filter(w => w.code !== 'base-url-v1');
    if (current.apiKey?.mode === 'env' && !current.apiKey.envPresent) {
        out.push({ code: 'env-missing', message: `${current.apiKey.envName} is not set in the daemon's environment; pi hides models whose key cannot be resolved.` });
    }
    if (current.providerId && current.apiKey?.mode === 'none') {
        out.push({ code: 'no-key', message: 'pi hides models whose provider has no resolvable API key.' });
    }
    if (Array.isArray(settings.enabledModels) && current.providerId) {
        const enabled = settings.enabledModels as unknown[];
        const hidden = (current.models ?? []).filter(m => !enabled.includes(`${current.providerId}/${m}`) && !enabled.includes(m));
        if (hidden.length) out.push({ code: 'enabled-models-filter', message: `settings.json enabledModels does not include ${hidden.join(', ')}.` });
    }
    return out;
}

export const piAdapter: HarnessAdapter = {
    id: 'pi',
    binary: 'pi',
    files: ctx => [{ role: MODELS, path: join(piAgentDir(ctx), 'models.json') }, { role: SETTINGS, path: join(piAgentDir(ctx), 'settings.json') }],
    view(files: FileSet, ctx: HarnessContext, opts) {
        const models = parseJsonObject(files[MODELS].content, 'models.json');
        const settings = parseJsonObject(files[SETTINGS].content, 'settings.json');
        const providers = providersOf(models);
        const active = str(settings.defaultProvider);
        const selected = opts.providerId ?? (active && providers[active] ? active : Object.keys(providers)[0] ?? null);
        const current = currentOf(models, settings, selected, ctx);
        return { current, providers: Object.keys(providers), pickerModels: pickerModelsOf(models), warnings: warningsOf(settings, current) };
    },
    plan(files: FileSet, raw: ModelConfigPatch, ctx: HarnessContext): HarnessPlan {
        const p = raw as PiPatch;
        const providerId = normalizeProviderId(p.providerId);
        const baseUrl = normalizeBaseUrl(p.baseUrl);
        if (p.api !== undefined && !(PI_APIS as readonly string[]).includes(p.api)) fail('invalid-input', `api must be one of ${PI_APIS.join(', ')}`);
        const apiKey = normalizeSecret(p.apiKey);
        if (apiKey.mode === 'literal' && /^[$!]/.test(apiKey.value)) fail('invalid-input', 'pi treats a key starting with $ or ! as an env reference / command; use the environment-variable mode');
        const ids = normalizeModelList(p.models);
        const windows = normalizeContextWindows(p.contextWindows);
        const defaultModel = normalizeModelId(p.defaultModel, 'defaultModel');
        if (p.activate !== undefined && typeof p.activate !== 'boolean') fail('invalid-input', 'activate must be a boolean');

        const modelsText = files[MODELS].content;
        const settingsText = files[SETTINGS].content;
        const modelsBefore = parseJsonObject(modelsText, 'models.json');
        const settingsBefore = parseJsonObject(settingsText, 'settings.json');
        const models = structuredClone(modelsBefore);
        const settings = structuredClone(settingsBefore);
        const providers = childObject(models, 'providers', 'models.json');
        const isNew = providers[providerId] === undefined;
        if (isNew && !baseUrl) fail('invalid-input', 'A new provider needs a base URL');
        const provider = childObject(providers, providerId, 'models.json.providers');
        if (baseUrl !== undefined) {
            if (baseUrl === null) fail('invalid-input', 'A provider needs a base URL');
            provider.baseUrl = baseUrl;
        }
        if (p.api !== undefined) provider.api = p.api;
        else if (isNew) provider.api = 'openai-completions';
        const secrets: string[] = [];
        if (apiKey.mode === 'literal') { provider.apiKey = apiKey.value; secrets.push(apiKey.value); }
        if (apiKey.mode === 'env') provider.apiKey = `\${${apiKey.name}}`;
        if (apiKey.mode === 'clear') delete provider.apiKey;
        if (ids !== undefined) {
            const existing = Array.isArray(provider.models) ? provider.models as JsonObject[] : [];
            const next = ids.map(id => existing.find(m => m && typeof m === 'object' && m.id === id) ?? { id });
            if (next.length) provider.models = next;
            else delete provider.models;
        }
        const finalIds = modelIds(provider);
        if (windows) {
            const entries = Array.isArray(provider.models) ? provider.models as JsonObject[] : [];
            for (const [id, window] of Object.entries(windows)) {
                const entry = entries.find(m => m && typeof m === 'object' && m.id === id);
                if (!entry) fail('invalid-input', `contextWindows names ${id}, which is not one of the provider models`);
                if (window === null) delete entry.contextWindow;
                else entry.contextWindow = window;
            }
        }
        if (p.activate === true) {
            settings.defaultProvider = providerId;
            const chosen = defaultModel ?? (finalIds.includes(str(settings.defaultModel) ?? '') ? str(settings.defaultModel) : finalIds[0]);
            setOrDelete(settings, 'defaultModel', chosen);
        } else if (p.activate === false && str(settings.defaultProvider) === providerId) {
            delete settings.defaultProvider;
            delete settings.defaultModel;
        } else if (defaultModel !== undefined && str(settings.defaultProvider) === providerId) {
            setOrDelete(settings, 'defaultModel', defaultModel);
        }
        if (defaultModel && !finalIds.includes(defaultModel)) fail('invalid-input', 'defaultModel must be one of the provider models');

        const modelKeys = changedPaths(modelsBefore, models, [['providers', providerId, 'baseUrl'], ['providers', providerId, 'api'], ['providers', providerId, 'apiKey'], ['providers', providerId, 'models']]);
        const settingsKeys = changedPaths(settingsBefore, settings, [['defaultProvider'], ['defaultModel']]);
        const current = currentOf(models, settings, providerId, ctx);
        return {
            contents: {
                [MODELS]: modelKeys.length ? stringifyLike(modelsText, models) : undefined,
                [SETTINGS]: settingsKeys.length ? stringifyLike(settingsText, settings) : undefined,
            },
            warnings: warningsOf(settings, current),
            changedKeys: [...modelKeys.map(k => `models.json.${k}`), ...settingsKeys.map(k => `settings.json.${k}`)],
            secrets,
        };
    },
    secretsIn(_role, content) {
        try {
            return collectSecretValues(parseJsonObject(content, 'pi config'));
        } catch {
            return new Set();
        }
    },
};

