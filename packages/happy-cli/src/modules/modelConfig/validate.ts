/**
 * B-688 input validation. Everything from the web is untrusted: a patch that
 * fails here is rejected with a stable code before any file is read for write.
 */
import { ModelConfigError } from './fileStore';
import { isValidEnvName } from './secrets';
import type { ConfigWarning, SecretInput } from './types';

const MODEL_ID = /^[A-Za-z0-9._:/@+\-[\]]{1,200}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function fail(code: string, message: string): never {
    throw new ModelConfigError(code, message);
}

/** undefined → keep; null/'' → remove; else a validated, trimmed URL string. */
export function normalizeBaseUrl(value: unknown, field = 'baseUrl'): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') fail('invalid-input', `${field} must be a string`);
    const v = value.trim();
    if (v === '') return null;
    if (v.length > 2048 || /\s/.test(v)) fail('invalid-input', `${field} is not a valid URL`);
    let url: URL;
    try {
        url = new URL(v);
    } catch {
        fail('invalid-input', `${field} is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('invalid-input', `${field} must be http(s)`);
    if (url.username || url.password) fail('invalid-input', `${field} must not embed credentials; use the API key field`);
    return v;
}

export function normalizeModelId(value: unknown, field = 'model'): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') fail('invalid-input', `${field} must be a string`);
    const v = value.trim();
    if (v === '') return null;
    if (!MODEL_ID.test(v)) fail('invalid-input', `${field} contains unsupported characters`);
    return v;
}

export function normalizeModelList(value: unknown, field = 'models'): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) fail('invalid-input', `${field} must be an array`);
    if (value.length > 64) fail('invalid-input', `${field} has too many entries`);
    const out: string[] = [];
    for (const item of value) {
        const id = normalizeModelId(item, field);
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

export function normalizeProviderId(value: unknown, reserved: readonly string[] = []): string {
    if (typeof value !== 'string' || !PROVIDER_ID.test(value.trim())) fail('invalid-input', 'providerId must be 1-64 letters, digits, - or _');
    const v = value.trim();
    if (reserved.includes(v)) fail('invalid-input', `providerId "${v}" is reserved by the harness`);
    return v;
}

export function normalizeSecret(value: unknown, allowed: readonly SecretInput['mode'][] = ['keep', 'clear', 'literal', 'env']): SecretInput {
    if (value === undefined) return { mode: 'keep' };
    if (!value || typeof value !== 'object') fail('invalid-input', 'apiKey must be an object');
    const v = value as Record<string, unknown>;
    const mode = v.mode;
    if (typeof mode !== 'string' || !allowed.includes(mode as SecretInput['mode'])) fail('invalid-input', `apiKey.mode must be one of ${allowed.join(', ')}`);
    if (mode === 'literal') {
        if (typeof v.value !== 'string') fail('invalid-input', 'apiKey.value must be a string');
        const key = v.value.trim();
        if (!key || key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) fail('invalid-input', 'apiKey.value must be a single line without spaces');
        return { mode: 'literal', value: key };
    }
    if (mode === 'env') {
        if (!isValidEnvName(v.name)) fail('invalid-input', 'apiKey.name must be an environment variable name');
        return { mode: 'env', name: v.name };
    }
    return { mode: mode as 'keep' | 'clear' };
}

/** Soft checks for the usual base-URL mistakes (the request path pasted in). */
export function baseUrlWarnings(url: string | null | undefined, kind: 'anthropic' | 'openai' | 'gemini'): ConfigWarning[] {
    if (!url) return [];
    const path = (() => { try { return new URL(url).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
    const out: ConfigWarning[] = [];
    if (/\/(chat\/completions|responses|messages|completions)$/.test(path)) {
        out.push({ code: 'base-url-has-endpoint', message: 'The base URL ends with an API endpoint path; harnesses append that themselves.' });
    }
    if (kind === 'anthropic' && /\/v1$/.test(path)) {
        out.push({ code: 'base-url-v1', message: 'Claude Code appends /v1/messages; a base URL ending in /v1 usually produces /v1/v1/messages.' });
    }
    if (kind === 'openai' && !/\/v\d/.test(path)) {
        out.push({ code: 'base-url-no-version', message: 'OpenAI-compatible base URLs usually end in /v1.' });
    }
    return out;
}

/** B-727: a model's context window in tokens — an integer pi can use, not a typo of 1M. */
export const MIN_CONTEXT_WINDOW = 1024;
export const MAX_CONTEXT_WINDOW = 100_000_000;

export function normalizeContextWindows(value: unknown): Record<string, number | null> | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input', 'contextWindows must be an object');
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) fail('invalid-input', 'contextWindows has too many entries');
    const out: Record<string, number | null> = {};
    for (const [rawId, window] of entries) {
        const id = normalizeModelId(rawId, 'contextWindows');
        if (!id) fail('invalid-input', 'contextWindows keys must be model ids');
        if (window === null) { out[id] = null; continue; }
        if (typeof window !== 'number' || !Number.isInteger(window) || window < MIN_CONTEXT_WINDOW || window > MAX_CONTEXT_WINDOW) {
            fail('invalid-input', `contextWindows.${id} must be a whole number of tokens between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}`);
        }
        out[id] = window;
    }
    return out;
}
