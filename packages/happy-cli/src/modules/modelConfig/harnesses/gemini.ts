/**
 * B-688 Gemini CLI adapter. Gemini has no custom-provider concept: it speaks
 * only the Gemini generateContent protocol, takes the key from GEMINI_API_KEY
 * (no settings.json field) and a gateway from GOOGLE_GEMINI_BASE_URL.
 * Files (`${GEMINI_CLI_HOME:-~}/.gemini/`):
 *   settings.json  → `model.name` (owned)
 *   .env           → GOOGLE_GEMINI_BASE_URL, GEMINI_API_KEY (owned)
 * `~/.gemini/.env` is Gemini's LAST-resort .env: a project `.gemini/.env` or
 * `.env` found walking up from the session cwd wins, which the view warns
 * about. Verified against google-gemini/gemini-cli v0.65.0 source
 * (packages/cli/src/config/settings.ts, packages/core/src/core/contentGenerator.ts).
 * No env-reference mode: Gemini's .env loader does not expand ${VAR}.
 */
import { join } from 'node:path';
import { editDotenv, parseDotenv } from '../dotenvEdit';
import { childObject, parseJsonObject, setOrDelete, stringifyLike, type JsonObject } from '../jsonEdit';
import { collectSecretValues, maskSecret } from '../secrets';
import type { ConfigWarning, FileSet, GeminiPatch, HarnessAdapter, HarnessContext, HarnessCurrent, HarnessPlan, ModelConfigPatch, SecretView } from '../types';
import { baseUrlWarnings, normalizeBaseUrl, normalizeModelId, normalizeSecret } from '../validate';
import { getPath, uniq } from './common';

const SETTINGS = 'settings';
const ENV = 'env';
const BASE_URL = 'GOOGLE_GEMINI_BASE_URL';
const API_KEY = 'GEMINI_API_KEY';

export function geminiDir(ctx: HarnessContext): string {
    return join(ctx.env.GEMINI_CLI_HOME?.trim() || ctx.home, '.gemini');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function currentOf(settings: JsonObject, env: Record<string, string>, ctx: HarnessContext): HarnessCurrent {
    const literal = str(env[API_KEY]);
    const apiKey: SecretView = literal
        ? { mode: 'literal', masked: maskSecret(literal) }
        : ctx.env[API_KEY] ? { mode: 'env', envName: API_KEY, envPresent: true } : { mode: 'none' };
    return { baseUrl: str(env[BASE_URL]), apiKey, model: str(getPath(settings, ['model', 'name'])) };
}

function warningsOf(settings: JsonObject, current: HarnessCurrent): ConfigWarning[] {
    const out: ConfigWarning[] = [...baseUrlWarnings(current.baseUrl, 'gemini')];
    if (current.baseUrl || current.apiKey?.mode === 'literal') {
        out.push({ code: 'project-env-shadows', message: '~/.gemini/.env is used only when the session folder (or a parent) has no .gemini/.env or .env of its own.' });
    }
    const selected = str(getPath(settings, ['security', 'auth', 'selectedType']));
    if (current.baseUrl && selected && selected !== 'gateway') {
        out.push({ code: 'auth-type-pinned', message: `security.auth.selectedType is "${selected}"; Gemini only uses GOOGLE_GEMINI_BASE_URL with the gateway auth type.` });
    }
    if (current.baseUrl && !/^https:/.test(current.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(current.baseUrl)) {
        out.push({ code: 'gemini-https', message: 'Gemini requires an https base URL (localhost excepted).' });
    }
    return out;
}

export const geminiAdapter: HarnessAdapter = {
    id: 'gemini',
    binary: 'gemini',
    files: ctx => [{ role: SETTINGS, path: join(geminiDir(ctx), 'settings.json') }, { role: ENV, path: join(geminiDir(ctx), '.env') }],
    view(files: FileSet, ctx: HarnessContext) {
        const settings = parseJsonObject(files[SETTINGS].content, 'settings.json');
        const current = currentOf(settings, parseDotenv(files[ENV].content), ctx);
        return { current, pickerModels: uniq([current.model]), warnings: warningsOf(settings, current) };
    },
    plan(files: FileSet, raw: ModelConfigPatch, ctx: HarnessContext): HarnessPlan {
        const p = raw as GeminiPatch;
        const baseUrl = normalizeBaseUrl(p.baseUrl);
        const apiKey = normalizeSecret(p.apiKey, ['keep', 'clear', 'literal']);
        const model = normalizeModelId(p.model);
        const settingsText = files[SETTINGS].content;
        const before = parseJsonObject(settingsText, 'settings.json');
        const settings = structuredClone(before);
        const changedKeys: string[] = [];
        let settingsOut: string | undefined;
        if (model !== undefined && (str(getPath(before, ['model', 'name'])) ?? null) !== model) {
            const hadModel = settings.model !== undefined;
            const modelObj = childObject(settings, 'model', 'settings');
            setOrDelete(modelObj, 'name', model);
            if (!hadModel && Object.keys(modelObj).length === 0) delete settings.model;
            settingsOut = stringifyLike(settingsText, settings);
            changedKeys.push('settings.model.name');
        }
        const envText = files[ENV].content;
        const env = parseDotenv(envText);
        const edits: { key: string; value: string | null }[] = [];
        if (baseUrl !== undefined && (env[BASE_URL] ?? null) !== baseUrl) edits.push({ key: BASE_URL, value: baseUrl });
        if (apiKey.mode === 'literal' && env[API_KEY] !== apiKey.value) edits.push({ key: API_KEY, value: apiKey.value });
        if (apiKey.mode === 'clear' && env[API_KEY] !== undefined) edits.push({ key: API_KEY, value: null });
        const envOut = edits.length ? editDotenv(envText, edits) : undefined;
        changedKeys.push(...edits.map(e => `.env.${e.key}`));
        const afterEnv = envOut === undefined ? env : parseDotenv(envOut);
        const current = currentOf(settings, afterEnv, ctx);
        return {
            contents: { [SETTINGS]: settingsOut, [ENV]: envOut },
            warnings: warningsOf(settings, current),
            changedKeys,
            secrets: apiKey.mode === 'literal' ? [apiKey.value] : [],
        };
    },
    secretsIn(role, content) {
        try {
            return role === ENV ? collectSecretValues(parseDotenv(content)) : collectSecretValues(parseJsonObject(content, 'settings.json'));
        } catch {
            return new Set();
        }
    },
};
