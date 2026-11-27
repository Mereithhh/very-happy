import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { HttpHeaderNameSchema, ModelFeedbackScopeSchema, ModelRequestTaggingSchema, type InstanceClientConfig } from '@slopus/happy-wire';

/**
 * Operator instance config (B-980, `specs/2026-11-model-feedback.md` §Config).
 *
 * One JSON file named by `VH_INSTANCE_CONFIG_FILE`, re-read when its mtime
 * changes (checked at most every 10 s), so an operator turns features on or
 * off without a release. Any string may be `${NAME}`-style: the reference is
 * replaced by the server environment variable, which keeps secrets (gateway
 * keys, forward credentials) out of the file. An unreadable or invalid file
 * never breaks the server: it serves the last good config (or "everything
 * off") and logs once per file version.
 *
 * Each section is parsed on its own, so a mistake in one does not switch off
 * the others.
 */

const RECHECK_MS = 10_000;

export const ModelFeedbackForwardSchema = z.object({
    url: z.string().url().refine(u => /^https?:\/\//i.test(u), 'http(s) only'),
    headers: z.record(HttpHeaderNameSchema, z.string().max(4096).regex(/^[^\r\n]*$/)).default({}),
    timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
});
export type ModelFeedbackForward = z.infer<typeof ModelFeedbackForwardSchema>;

export const ModelFeedbackConfigSchema = z.object({
    enabled: z.boolean().default(true),
    scope: ModelFeedbackScopeSchema.default('tagged'),
    forward: ModelFeedbackForwardSchema.nullable().default(null),
});
export type ModelFeedbackConfig = z.infer<typeof ModelFeedbackConfigSchema>;

export interface InstanceConfig {
    /** Accounts allowed to export feedback and see admin views. Empty = only `VH_FEEDBACK_ADMIN_ACCOUNT_IDS`. */
    admins: string[];
    modelRequestTagging: z.infer<typeof ModelRequestTaggingSchema> | null;
    modelFeedback: ModelFeedbackConfig | null;
    /** Raw sections owned by other modules; each parses its own. */
    raw: Record<string, unknown>;
}

export const EMPTY_INSTANCE_CONFIG: InstanceConfig = { admins: [], modelRequestTagging: null, modelFeedback: null, raw: {} };

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces `${NAME}` in every string of a JSON value. A missing variable is reported and becomes ''. */
export function expandEnvRefs(value: unknown, env: Record<string, string | undefined>, missing: Set<string>): unknown {
    if (typeof value === 'string') {
        return value.replace(ENV_REF, (_m, name: string) => {
            const v = env[name];
            if (v === undefined) missing.add(name);
            return v ?? '';
        });
    }
    if (Array.isArray(value)) return value.map(v => expandEnvRefs(v, env, missing));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvRefs(v, env, missing)]));
    }
    return value;
}

function section<T>(schema: z.ZodType<T>, value: unknown, name: string, problems: string[]): T | null {
    if (value === undefined || value === null) return null;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    problems.push(`${name}: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    return null;
}

/** Pure: JSON text → config + human-readable problems (never throws). */
export function parseInstanceConfig(text: string, env: Record<string, string | undefined> = process.env): { config: InstanceConfig; problems: string[] } {
    const problems: string[] = [];
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        return { config: EMPTY_INSTANCE_CONFIG, problems: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { config: EMPTY_INSTANCE_CONFIG, problems: ['top level must be an object'] };
    const missing = new Set<string>();
    const raw = expandEnvRefs(json, env, missing) as Record<string, unknown>;
    if (missing.size > 0) problems.push(`unset environment variables: ${[...missing].sort().join(', ')}`);
    const admins = section(z.array(z.string().min(1).max(128)).max(200), raw.admins, 'admins', problems) ?? [];
    const modelRequestTagging = section(ModelRequestTaggingSchema, raw.modelRequestTagging, 'modelRequestTagging', problems);
    const modelFeedback = section(ModelFeedbackConfigSchema, raw.modelFeedback, 'modelFeedback', problems);
    return { config: { admins, modelRequestTagging, modelFeedback, raw }, problems };
}

export function createInstanceConfigSource(opts: {
    file?: string | null;
    now?: () => number;
    env?: Record<string, string | undefined>;
    warn?: (message: string) => void;
} = {}) {
    const file = opts.file?.trim() || null;
    const now = opts.now ?? Date.now;
    const warn = opts.warn ?? ((message: string) => console.warn(message));
    let cached: InstanceConfig = EMPTY_INSTANCE_CONFIG;
    let checkedAt = -Infinity;
    let loadedMtime: number | null = null;

    return function get(): InstanceConfig {
        if (!file || now() - checkedAt < RECHECK_MS) return cached;
        checkedAt = now();
        try {
            const mtime = statSync(file).mtimeMs;
            if (mtime === loadedMtime) return cached;
            loadedMtime = mtime;
            const { config, problems } = parseInstanceConfig(readFileSync(file, 'utf8'), opts.env ?? process.env);
            // Problems name keys and variables, never values.
            if (problems.length > 0) warn(`[instance-config] ${file}: ${problems.join(' | ')}`);
            cached = config;
        } catch (error) {
            if (loadedMtime !== -1) warn(`[instance-config] cannot read ${file} (${error instanceof Error ? error.message : String(error)}); features it configures are off`);
            loadedMtime = -1;
            cached = EMPTY_INSTANCE_CONFIG;
        }
        return cached;
    };
}

let defaultSource: (() => InstanceConfig) | null = null;

/** The process-wide config (reads `VH_INSTANCE_CONFIG_FILE` lazily so tests can set it first). */
export function instanceConfig(): InstanceConfig {
    if (!defaultSource) defaultSource = createInstanceConfigSource({ file: process.env.VH_INSTANCE_CONFIG_FILE });
    return defaultSource();
}

/** Test hook: replace the process-wide source. */
export function setInstanceConfigSource(source: (() => InstanceConfig) | null): void {
    defaultSource = source;
}

/** What `GET /v1/instance/config` tells clients. Never includes forward targets or credentials. */
export function clientInstanceConfig(config: InstanceConfig): InstanceClientConfig {
    const fb = config.modelFeedback;
    return {
        modelRequestTagging: config.modelRequestTagging,
        modelFeedback: fb ? { enabled: fb.enabled, scope: fb.scope } : null,
    };
}
