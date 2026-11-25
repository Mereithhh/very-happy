/**
 * B-974c: `vh-plugin/v1` manifest — local draft of the wire schema
 * (DESIGN §2.1). When B-974a lands the wire schema, this file re-exports it;
 * the field table below is the contract until then.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PLUGIN_SCHEMA_V1 = 'vh-plugin/v1';
/** The `/plugin/v1` feature level this daemon implements (§7 `pluginApi`). */
export const PLUGIN_API_LEVEL = 1;
export const PLUGIN_MANIFEST_MAX_BYTES = 32 * 1024;

export const PLUGIN_PERMISSIONS = ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.list', 'sessions.read'] as const;
export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
export const SENSITIVE_PLUGIN_PERMISSIONS: readonly PluginPermission[] = ['sessions.list', 'sessions.read'];

export const PLUGIN_BUILTIN_ICONS = ['kanban', 'bot', 'inbox', 'bell', 'chart', 'list', 'terminal', 'puzzle', 'calendar', 'code', 'globe', 'star', 'check', 'flag'] as const;

const NO_CONTROL = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** One emoji (incl. ZWJ sequences / variation selectors), no letters or digits. */
const SINGLE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic})|\p{Emoji_Modifier}|\p{Regional_Indicator})*$/u;

export type LoopbackUrl = { host: '127.0.0.1' | '::1'; port: number; path: string };

/**
 * `http://127.0.0.1:<port>` or `http://[::1]:<port>`, port 1024–65535, no
 * userinfo / query / fragment. `allowPath` is for `callback.url`. Parsing is
 * strict on the raw string: WHATWG URL would normalise `http://2130706433/`
 * or `http://localhost` into something this check must never accept.
 */
export function parseLoopbackUrl(raw: string, allowPath: boolean): LoopbackUrl | null {
    if (typeof raw !== 'string' || raw.length > 512) return null;
    const m = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})(\/[^?#\s]*)?$/.exec(raw);
    if (!m) return null;
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || String(port) !== m[2]) return null;
    const path = m[3] ?? '';
    if (!allowPath && path !== '' && path !== '/') return null;
    if (path.includes('\\') || /%2e|%2f|%5c|%00/i.test(path) || path.split('/').some((s) => s === '..' || s === '.')) return null;
    return { host: m[1] === '[::1]' ? '::1' : '127.0.0.1', port, path: path || '/' };
}

const upstreamSchema = z.string().refine((v) => parseLoopbackUrl(v, false) !== null, {
    message: 'must be http://127.0.0.1:<port> or http://[::1]:<port> (port 1024–65535, no path)',
});
const callbackUrlSchema = z.string().refine((v) => parseLoopbackUrl(v, true) !== null, {
    message: 'must be http://127.0.0.1:<port>/path or http://[::1]:<port>/path (port 1024–65535)',
});

const panelSchema = z.object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/),
    title: z.string().min(1).max(40).regex(NO_CONTROL),
    upstream: upstreamSchema,
    entry: z.string().max(512).startsWith('/').optional(),
});

export const PluginManifestSchema = z.object({
    schema: z.literal(PLUGIN_SCHEMA_V1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
    name: z.string().min(1).max(40).regex(NO_CONTROL),
    version: z.string().max(32).regex(SEMVER),
    description: z.string().max(280).optional(),
    publisher: z.object({
        name: z.string().min(1).max(60).regex(NO_CONTROL),
        url: z.string().max(200).startsWith('https://').optional(),
    }).optional(),
    icon: z.string().max(32).refine((v) => (PLUGIN_BUILTIN_ICONS as readonly string[]).includes(v) || SINGLE_EMOJI.test(v), {
        message: 'must be a built-in icon name or a single emoji',
    }).optional(),
    minApi: z.number().int().min(1).optional(),
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length),
    sidebar: z.object({ title: z.string().min(1).max(24).regex(NO_CONTROL), panel: z.string() }).optional(),
    panels: z.array(panelSchema).min(1).max(4).optional(),
    callback: z.object({ url: callbackUrlSchema }).optional(),
    sessionWidget: z.boolean().optional(),
}).passthrough().superRefine((m, ctx) => {
    const perms = new Set(m.permissions);
    if (perms.size !== m.permissions.length) ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'duplicate permission' });
    if (perms.has('sidebar') && !m.sidebar) ctx.addIssue({ code: 'custom', path: ['sidebar'], message: 'required with the sidebar permission' });
    if (perms.has('panel') && !m.panels) ctx.addIssue({ code: 'custom', path: ['panels'], message: 'required with the panel permission' });
    if (perms.has('session.widget') && m.sessionWidget !== true) ctx.addIssue({ code: 'custom', path: ['sessionWidget'], message: 'must be true with the session.widget permission' });
    if (m.panels) {
        const ids = m.panels.map((p) => p.id);
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['panels'], message: 'duplicate panel id' });
        if (m.sidebar && !ids.includes(m.sidebar.panel)) ctx.addIssue({ code: 'custom', path: ['sidebar', 'panel'], message: 'must name a declared panel' });
    } else if (m.sidebar) {
        ctx.addIssue({ code: 'custom', path: ['sidebar', 'panel'], message: 'must name a declared panel' });
    }
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

const KNOWN_FIELDS = new Set(['schema', 'id', 'name', 'version', 'description', 'publisher', 'icon', 'minApi', 'permissions', 'sidebar', 'panels', 'callback', 'sessionWidget']);

export type ManifestParseResult =
    | { ok: true; manifest: PluginManifest; warnings: string[] }
    | { ok: false; code: 'invalid_manifest' | 'unsupported_schema' | 'api_too_old' | 'payload_too_large'; message: string; issues?: string[] };

/** Validate raw manifest text (§2.1, §7 compatibility rows). */
export function parsePluginManifest(text: string, daemonApiLevel = PLUGIN_API_LEVEL): ManifestParseResult {
    if (Buffer.byteLength(text, 'utf8') > PLUGIN_MANIFEST_MAX_BYTES) return { ok: false, code: 'payload_too_large', message: `manifest is larger than ${PLUGIN_MANIFEST_MAX_BYTES} bytes` };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, code: 'invalid_manifest', message: `not JSON: ${(e as Error).message}` }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_manifest', message: 'manifest must be a JSON object' };
    const schema = (raw as Record<string, unknown>).schema;
    if (typeof schema === 'string' && /^vh-plugin\/v\d+$/.test(schema) && schema !== PLUGIN_SCHEMA_V1) {
        return { ok: false, code: 'unsupported_schema', message: `unsupported manifest schema ${schema} (this CLI knows ${PLUGIN_SCHEMA_V1})` };
    }
    const parsed = PluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return { ok: false, code: 'invalid_manifest', message: 'manifest is invalid', issues };
    }
    const minApi = parsed.data.minApi ?? 1;
    if (minApi > daemonApiLevel) return { ok: false, code: 'api_too_old', message: `plugin needs /plugin/v1 level ${minApi}; this CLI provides ${daemonApiLevel}` };
    const warnings = Object.keys(raw as object).filter((k) => !KNOWN_FIELDS.has(k)).map((k) => `unknown field "${k}" ignored`);
    return { ok: true, manifest: parsed.data, warnings };
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function manifestHash(manifest: PluginManifest): string {
    return sha256hex(canonicalJson(manifest));
}

/** The fields whose change needs a new approval (§2.1, §3.3). */
export function privilegedView(m: PluginManifest): Record<string, unknown> {
    return {
        id: m.id,
        name: m.name,
        icon: m.icon ?? 'puzzle',
        permissions: [...m.permissions].sort(),
        panels: (m.panels ?? []).map((p) => ({ id: p.id, upstream: p.upstream })).sort((a, b) => (a.id < b.id ? -1 : 1)),
        callback: m.callback ? { url: m.callback.url } : null,
        sidebar: m.sidebar ? { panel: m.sidebar.panel } : null,
        sessionWidget: m.sessionWidget === true,
    };
}

export function privilegedHash(manifest: PluginManifest): string {
    return sha256hex(canonicalJson(privilegedView(manifest)));
}

/**
 * Does `next` only narrow `approved` (fewer permissions / panels, nothing
 * new or changed)? Then it takes effect without a new approval (§3.3).
 */
export function isPrivilegeReduction(approved: PluginManifest, next: PluginManifest): boolean {
    const a = privilegedView(approved) as ReturnType<typeof privilegedView> & Record<string, any>;
    const n = privilegedView(next) as ReturnType<typeof privilegedView> & Record<string, any>;
    if (a.id !== n.id || a.name !== n.name || a.icon !== n.icon) return false;
    if (!(n.permissions as string[]).every((p) => (a.permissions as string[]).includes(p))) return false;
    const approvedPanels = new Map((a.panels as Array<{ id: string; upstream: string }>).map((p) => [p.id, p.upstream]));
    if (!(n.panels as Array<{ id: string; upstream: string }>).every((p) => approvedPanels.get(p.id) === p.upstream)) return false;
    if (n.callback && (!a.callback || n.callback.url !== a.callback.url)) return false;
    if (n.sidebar && (!a.sidebar || n.sidebar.panel !== a.sidebar.panel)) return false;
    if (n.sessionWidget && !a.sessionWidget) return false;
    return true;
}
