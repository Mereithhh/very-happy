/**
 * B-688 Claude Code adapter — `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`
 * (user scope; strict JSON). Owned keys, nothing else is touched:
 *   env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN | env.ANTHROPIC_API_KEY,
 *   env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL, `model`,
 *   `modelPicker.options`, our own `apiKeyHelper` (env-reference mode), and
 *   appending our model ids to an existing `availableModels` allowlist.
 * Format verified against code.claude.com docs (settings / env-vars /
 * model-config) and Claude Code 2.1.304 — see the spec's 现状事实 table.
 */
import { join } from 'node:path';
import { childObject, parseJsonObject, setOrDelete, stringifyLike, type JsonObject } from '../jsonEdit';
import { collectSecretValues, maskSecret } from '../secrets';
import type { ClaudePatch, ConfigWarning, FileSet, HarnessAdapter, HarnessContext, HarnessCurrent, HarnessPlan, ModelConfigPatch, SecretView } from '../types';
import { baseUrlWarnings, fail, normalizeBaseUrl, normalizeModelId, normalizeModelList, normalizeSecret } from '../validate';
import { changedPaths, uniq } from './common';

const ROLE = 'settings';
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const API_KEY = 'ANTHROPIC_API_KEY';
const ALIAS_VARS = { opusModel: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnetModel: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haikuModel: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' } as const;

/** The apiKeyHelper we write for "use an environment variable". Recognised on read. */
export function claudeEnvHelper(name: string): string {
    return `printf %s "$${name}"`;
}
const OUR_HELPER = /^printf %s "\$([A-Za-z_][A-Za-z0-9_]*)"$/;

const OWNED_PATHS = [
    ['env', 'ANTHROPIC_BASE_URL'], ['env', AUTH_TOKEN], ['env', API_KEY],
    ['env', ALIAS_VARS.opusModel], ['env', ALIAS_VARS.sonnetModel], ['env', ALIAS_VARS.haikuModel],
    ['model'], ['modelPicker', 'options'], ['apiKeyHelper'], ['availableModels'],
];

export function claudeSettingsPath(ctx: HarnessContext): string {
    const dir = ctx.env.CLAUDE_CONFIG_DIR?.trim() || join(ctx.home, '.claude');
    return join(dir, 'settings.json');
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v : null;
}

function envOf(settings: JsonObject): JsonObject {
    const env = settings.env;
    return env && typeof env === 'object' && !Array.isArray(env) ? env as JsonObject : {};
}

function pickerOptions(settings: JsonObject): JsonObject[] {
    const picker = settings.modelPicker;
    if (!picker || typeof picker !== 'object' || Array.isArray(picker)) return [];
    const options = (picker as JsonObject).options;
    return Array.isArray(options) ? options.filter((o): o is JsonObject => !!o && typeof o === 'object' && typeof (o as JsonObject).model === 'string') : [];
}

function secretView(settings: JsonObject, ctx: HarnessContext): SecretView {
    const env = envOf(settings);
    const literal = str(env[AUTH_TOKEN]) ?? str(env[API_KEY]);
    if (literal) return { mode: 'literal', masked: maskSecret(literal) };
    const helper = str(settings.apiKeyHelper);
    if (helper) {
        const ours = OUR_HELPER.exec(helper.trim());
        if (ours) return { mode: 'env', envName: ours[1], envPresent: !!ctx.env[ours[1]] };
        return { mode: 'command' };
    }
    return { mode: 'none' };
}

function currentOf(settings: JsonObject, ctx: HarnessContext): HarnessCurrent {
    const env = envOf(settings);
    return {
        baseUrl: str(env.ANTHROPIC_BASE_URL),
        authHeader: !str(env[AUTH_TOKEN]) && str(env[API_KEY]) ? 'x-api-key' : 'bearer',
        apiKey: secretView(settings, ctx),
        model: str(settings.model),
        opusModel: str(env[ALIAS_VARS.opusModel]),
        sonnetModel: str(env[ALIAS_VARS.sonnetModel]),
        haikuModel: str(env[ALIAS_VARS.haikuModel]),
        pickerModels: pickerOptions(settings).map(o => o.model as string),
    };
}

function pickerModelsOf(current: HarnessCurrent): string[] {
    return uniq([current.model, current.opusModel, current.sonnetModel, current.haikuModel, ...(current.pickerModels ?? [])]);
}

function warningsOf(settings: JsonObject, current: HarnessCurrent, ctx: HarnessContext): ConfigWarning[] {
    const env = envOf(settings);
    const out: ConfigWarning[] = [...baseUrlWarnings(current.baseUrl, 'anthropic')];
    if (str(env.ANTHROPIC_MODEL)) {
        out.push({ code: 'env-model-overrides', message: 'env.ANTHROPIC_MODEL is set in settings.json and overrides the default model.' });
    }
    const daemonOther = current.authHeader === 'bearer' ? API_KEY : AUTH_TOKEN;
    if (current.baseUrl && ctx.env[daemonOther]) {
        out.push({ code: 'daemon-env-credential', message: `The daemon's environment also defines ${daemonOther}; sessions inherit it.` });
    }
    if (current.apiKey?.mode === 'env' && !current.apiKey.envPresent) {
        out.push({ code: 'env-missing', message: `${current.apiKey.envName} is not set in the daemon's environment, so sessions will not get a key.` });
    }
    if (Array.isArray(settings.availableModels)) {
        const allowed = settings.availableModels as unknown[];
        const missing = pickerModelsOf(current).filter(id => !allowed.includes(id));
        if (missing.length) out.push({ code: 'available-models-filter', message: `availableModels does not list ${missing.join(', ')}; Claude Code hides them.` });
    }
    return out;
}

function parsePatch(raw: ModelConfigPatch): Required<Pick<ClaudePatch, 'apiKey'>> & ClaudePatch {
    const p = raw as ClaudePatch;
    if (p.authHeader !== undefined && p.authHeader !== 'bearer' && p.authHeader !== 'x-api-key') fail('invalid-input', 'authHeader must be bearer or x-api-key');
    return {
        harness: 'claude',
        baseUrl: normalizeBaseUrl(p.baseUrl),
        authHeader: p.authHeader,
        apiKey: normalizeSecret(p.apiKey),
        model: normalizeModelId(p.model),
        opusModel: normalizeModelId(p.opusModel, 'opusModel'),
        sonnetModel: normalizeModelId(p.sonnetModel, 'sonnetModel'),
        haikuModel: normalizeModelId(p.haikuModel, 'haikuModel'),
        pickerModels: normalizeModelList(p.pickerModels, 'pickerModels'),
    };
}

export const claudeAdapter: HarnessAdapter = {
    id: 'claude',
    binary: 'claude',
    files: ctx => [{ role: ROLE, path: claudeSettingsPath(ctx) }],
    view(files: FileSet, ctx: HarnessContext) {
        const settings = parseJsonObject(files[ROLE].content, 'settings.json');
        const current = currentOf(settings, ctx);
        return { current, pickerModels: pickerModelsOf(current), warnings: warningsOf(settings, current, ctx) };
    },
    plan(files: FileSet, raw: ModelConfigPatch, ctx: HarnessContext): HarnessPlan {
        const patch = parsePatch(raw);
        const original = files[ROLE].content;
        const before = parseJsonObject(original, 'settings.json');
        const settings = structuredClone(before);
        const hadEnv = settings.env !== undefined;
        const env = childObject(settings, 'env', 'settings');
        if (patch.baseUrl !== undefined) setOrDelete(env, 'ANTHROPIC_BASE_URL', patch.baseUrl);
        const currentHeader = !str(env[AUTH_TOKEN]) && str(env[API_KEY]) ? 'x-api-key' : 'bearer';
        const header = patch.authHeader ?? currentHeader;
        const target = header === 'bearer' ? AUTH_TOKEN : API_KEY;
        const other = header === 'bearer' ? API_KEY : AUTH_TOKEN;
        const helperIsOurs = typeof settings.apiKeyHelper === 'string' && OUR_HELPER.test(settings.apiKeyHelper.trim());
        const secrets: string[] = [];
        switch (patch.apiKey.mode) {
            case 'literal':
                env[target] = patch.apiKey.value;
                delete env[other];
                if (helperIsOurs) delete settings.apiKeyHelper;
                secrets.push(patch.apiKey.value);
                break;
            case 'env':
                settings.apiKeyHelper = claudeEnvHelper(patch.apiKey.name);
                delete env[AUTH_TOKEN];
                delete env[API_KEY];
                break;
            case 'clear':
                delete env[AUTH_TOKEN];
                delete env[API_KEY];
                if (helperIsOurs) delete settings.apiKeyHelper;
                break;
            case 'keep':
                // Switching the header moves an existing literal key to the other variable.
                if (header !== currentHeader && str(env[other]) && !str(env[target])) {
                    env[target] = env[other];
                    delete env[other];
                }
                break;
        }
        if (patch.model !== undefined) setOrDelete(settings, 'model', patch.model);
        for (const [field, variable] of Object.entries(ALIAS_VARS) as [keyof typeof ALIAS_VARS, string][]) {
            if (patch[field] !== undefined) setOrDelete(env, variable, patch[field]);
        }
        if (patch.pickerModels !== undefined) {
            const hadPicker = settings.modelPicker !== undefined;
            const picker = childObject(settings, 'modelPicker', 'settings');
            const existing = pickerOptions(settings);
            const next = patch.pickerModels.map(id => existing.find(o => o.model === id) ?? { model: id });
            if (next.length) picker.options = next;
            else delete picker.options;
            if (!hadPicker && Object.keys(picker).length === 0) delete settings.modelPicker;
        }
        if (!hadEnv && Object.keys(env).length === 0) delete settings.env;
        const current = currentOf(settings, ctx);
        if (Array.isArray(settings.availableModels)) {
            const allowed = settings.availableModels as unknown[];
            const add = pickerModelsOf(current).filter(id => !allowed.includes(id));
            if (add.length) settings.availableModels = [...allowed, ...add];
        }
        const changedKeys = changedPaths(before, settings, OWNED_PATHS);
        const content = changedKeys.length === 0 ? undefined : stringifyLike(original, settings);
        return { contents: { [ROLE]: content }, warnings: warningsOf(settings, current, ctx), changedKeys, secrets };
    },
    secretsIn(_role, content) {
        try {
            return collectSecretValues(parseJsonObject(content, 'settings.json'));
        } catch {
            return new Set();
        }
    },
};
