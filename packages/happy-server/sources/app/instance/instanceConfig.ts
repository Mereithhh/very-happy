import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import {
    HttpHeaderNameSchema, ModelFeedbackScopeSchema, ModelRequestTaggingSchema, NOTICE_BODY_MAX, NOTICE_TITLE_MAX, NoticeIdSchema, NoticeLevelSchema,
    type InstanceClientConfig,
} from '@slopus/happy-wire';

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

const IsoTimeSchema = z.string().max(64).refine(v => !Number.isNaN(Date.parse(v)), 'not an ISO time');

/**
 * B-982: one operator notice. `audience` is `'all'` or a list of account ids
 * (an entry may also be a username). Times are ISO strings; the notice shows
 * from `startsAt` (inclusive) until `endsAt` (exclusive).
 */
export const NoticeConfigSchema = z.object({
    id: NoticeIdSchema,
    title: z.string().trim().min(1).max(NOTICE_TITLE_MAX),
    body: z.string().max(NOTICE_BODY_MAX).default(''),
    level: NoticeLevelSchema.default('info'),
    audience: z.union([z.literal('all'), z.object({ accounts: z.array(z.string().min(1).max(128)).min(1).max(1000) })]).default('all'),
    startsAt: IsoTimeSchema.optional(),
    endsAt: IsoTimeSchema.optional(),
    dismissible: z.boolean().default(true),
}).refine(n => !n.startsAt || !n.endsAt || Date.parse(n.startsAt) < Date.parse(n.endsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type NoticeConfig = z.infer<typeof NoticeConfigSchema>;

export const NOTICES_MAX = 50;

/** Each notice is parsed on its own: a bad one is dropped (and named), the rest stay. */
function noticesSection(value: unknown, problems: string[]): NoticeConfig[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        problems.push('notices: must be an array');
        return [];
    }
    if (value.length > NOTICES_MAX) problems.push(`notices: ${value.length} entries, only the first ${NOTICES_MAX} are used`);
    const out: NoticeConfig[] = [];
    const seen = new Set<string>();
    value.slice(0, NOTICES_MAX).forEach((entry, index) => {
        const rawId = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
        const name = typeof rawId === 'string' && NoticeIdSchema.safeParse(rawId).success ? `"${rawId}"` : `#${index}`;
        const parsed = NoticeConfigSchema.safeParse(entry);
        if (!parsed.success) {
            problems.push(`notices[${name}] dropped: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
            return;
        }
        if (seen.has(parsed.data.id)) {
            problems.push(`notices[${name}] dropped: duplicate id`);
            return;
        }
        seen.add(parsed.data.id);
        out.push(parsed.data);
    });
    return out;
}

export interface InstanceConfig {
    /** Accounts allowed to export feedback and see admin views. Empty = only `VH_FEEDBACK_ADMIN_ACCOUNT_IDS`. */
    admins: string[];
    modelRequestTagging: z.infer<typeof ModelRequestTaggingSchema> | null;
    modelFeedback: ModelFeedbackConfig | null;
    /** B-982 operator notices, valid entries only, in file order. */
    notices: NoticeConfig[];
    /** Raw sections owned by other modules; each parses its own. */
    raw: Record<string, unknown>;
}

export const EMPTY_INSTANCE_CONFIG: InstanceConfig = { admins: [], modelRequestTagging: null, modelFeedback: null, notices: [], raw: {} };

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
    const notices = noticesSection(raw.notices, problems);
    return { config: { admins, modelRequestTagging, modelFeedback, notices, raw }, problems };
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
