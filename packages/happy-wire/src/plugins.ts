import { z } from 'zod';
import { pluginCanonicalJson, pluginSha256Hex } from './pluginCrypto';

// B-974 Web plugins v1 (design: B-973). A plugin is a local process on one
// machine plus a `vh-plugin/v1` manifest. It talks only to the local daemon
// (`/plugin/v1/*`, bearer plugin token); the daemon relays to the server over
// the authenticated machine socket (`plugin-op`). Panels are proxied from a
// per-install origin through the daemon (`plugin-http`). Everything else
// (badge, decision cards, session widgets) is rendered natively by the host.
//
// Request schemas validate (strip unknown keys). Response / view schemas keep
// enum-like fields as open strings so an older client tolerates values a newer
// host adds (AGENTS #4/#14); use the `PLUGIN_*` lists to interpret them.

// ─── Constants ───────────────────────────────────────────────────────────────

export const PLUGIN_MANIFEST_SCHEMA = 'vh-plugin/v1';
/** `/plugin/v1` feature level the daemon publishes as machine metadata `pluginApi`. */
export const PLUGIN_API_VERSION = 1;
/** Server capability in `/v1/features`. */
export const PLUGIN_SERVER_FEATURE = 'plugins-v1';
/** Features `GET /plugin/v1/info` lists at API level 1. Additive within v1. */
export const PLUGIN_API_FEATURES = ['badge', 'panel', 'decisions', 'decisions.input', 'widget', 'events.pull'] as const;
/** Path prefix of the daemon-local API. */
export const PLUGIN_API_PREFIX = '/plugin/v1';
/** Host-reserved paths on a plugin origin (never forwarded to the plugin). */
export const PLUGIN_RESERVED_PATHS = ['/__vh/enter', '/__vh/health'] as const;
/** Cookie the server sets on a plugin origin; the daemon strips it before forwarding, plugin `Set-Cookie` with this prefix is dropped. */
export const PLUGIN_FRAME_COOKIE = '__Host-vhp';

export const PLUGIN_LIMITS = {
    manifestBytes: 32 * 1024,
    idPattern: /^[a-z0-9][a-z0-9-]{1,31}$/,
    nameChars: 40,
    versionChars: 32,
    descriptionChars: 280,
    publisherNameChars: 60,
    publisherUrlChars: 200,
    sidebarTitleChars: 24,
    panels: { min: 1, max: 4 },
    panelIdPattern: /^[a-z0-9-]{1,32}$/,
    panelTitleChars: 40,
    pathChars: 512,
    portMin: 1024,
    portMax: 65535,
    /** Request bodies of `/plugin/v1/*` (413 above). */
    apiBodyBytes: 64 * 1024,
    idempotencyKeyChars: 128,
    badgeCountMax: 9999,
    badgeLabelChars: 16,
    badgeWritesPerMinute: 60,
    decisionKeyChars: 256,
    decisionTitleChars: 120,
    decisionBodyBytes: 8 * 1024,
    decisionOptions: { min: 2, max: 4 },
    optionIdPattern: /^[a-z0-9_-]{1,16}$/,
    decisionOptionLabelChars: 40,
    decisionOptionDetailChars: 200,
    inputPlaceholderChars: 80,
    inputMaxLength: 2000,
    inputDefaultMaxLength: 500,
    decisionNoteChars: 500,
    decisionListMax: 200,
    activeDecisionsPerInstall: 50,
    decisionCreatesPerMinute: 30,
    widgetLabelChars: 24,
    widgetTextChars: 280,
    widgetActions: 2,
    widgetActionLabelChars: 20,
    widgetConfirmChars: 120,
    widgetsPerSessionShown: 3,
    widgetWritesPerSessionPerMinute: 30,
    eventsWaitMaxSec: 25,
    sessionsListMax: 100,
    sessionMessagesMax: 50,
    offlineQueuePerInstall: 200,
    concurrentProxyRequests: 16,
    bridgeCallsPerSecond: 20,
    reasonChars: 280,
} as const;

/** Built-in icon names a manifest may use (or a single emoji). SVG and image URLs are never accepted. */
export const PLUGIN_ICONS = [
    'puzzle', 'kanban', 'bot', 'inbox', 'bell', 'chart', 'list', 'terminal',
    'calendar', 'check', 'clock', 'code', 'database', 'file', 'flag', 'folder',
    'globe', 'heart', 'home', 'layers', 'mail', 'map', 'package', 'rocket',
    'search', 'server', 'settings', 'shield', 'star', 'tag', 'user', 'zap',
] as const;
export type PluginIcon = typeof PLUGIN_ICONS[number];
export const PLUGIN_DEFAULT_ICON: PluginIcon = 'puzzle';

/** §3.1. Unknown permissions are rejected by the manifest schema. */
export const PLUGIN_PERMISSIONS = ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.list', 'sessions.read'] as const;
export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
/** Sensitive permissions: unchecked by default, second confirmation on the review page. */
export const PLUGIN_SENSITIVE_PERMISSIONS: readonly PluginPermission[] = ['sessions.list', 'sessions.read'];
export const PLUGIN_PERMISSION_RISK: Record<PluginPermission, 'low' | 'medium' | 'sensitive'> = {
    sidebar: 'low',
    panel: 'medium',
    decisions: 'medium',
    'session.widget': 'medium',
    'sessions.list': 'sensitive',
    'sessions.read': 'sensitive',
};
export function isPluginPermissionSensitive(p: string): boolean {
    return (PLUGIN_SENSITIVE_PERMISSIONS as readonly string[]).includes(p);
}
/** Grants the review page pre-checks: every requested permission except the sensitive ones. */
export function pluginDefaultGrants(requested: readonly string[]): PluginPermission[] {
    return requested.filter((p): p is PluginPermission => (PLUGIN_PERMISSIONS as readonly string[]).includes(p) && !isPluginPermissionSensitive(p));
}

/**
 * Install lifecycle. `update_pending`: a privileged change waits for approval
 * while the previously approved manifest and grants stay in force.
 */
export const PLUGIN_INSTALL_STATES = ['pending', 'enabled', 'update_pending', 'disabled', 'rejected', 'disabled_by_operator', 'removed'] as const;
export type PluginInstallState = typeof PLUGIN_INSTALL_STATES[number];
/** States in which the approved manifest and grants are in force. */
export function isPluginInstallActive(state: string): boolean {
    return state === 'enabled' || state === 'update_pending';
}
/** `/plugin/v1` error code for a non-active install state; null when calls are allowed. */
export function pluginStateError(state: string): PluginErrorCode | null {
    if (isPluginInstallActive(state)) return null;
    if (state === 'pending') return 'plugin_pending';
    if (state === 'rejected') return 'plugin_rejected';
    if (state === 'disabled_by_operator') return 'disabled_by_operator';
    return 'plugin_disabled';
}

// ─── Errors (§5.1, §7) ───────────────────────────────────────────────────────

export const PLUGIN_ERROR_STATUS = {
    invalid_request: 400,
    invalid_path: 400,
    unauthorized: 401,
    permission_denied: 403,
    plugin_disabled: 403,
    plugin_rejected: 403,
    plugin_pending: 403,
    disabled_by_operator: 403,
    session_not_on_machine: 403,
    not_found: 404,
    version_conflict: 409,
    manifest_changed: 409,
    payload_too_large: 413,
    limit_exceeded: 422,
    rate_limited: 429,
    unsupported_upgrade: 501,
    upstream_unreachable: 502,
    server_unreachable: 503,
    upstream_timeout: 504,
} as const;
export type PluginErrorCode = keyof typeof PLUGIN_ERROR_STATUS;
export const PLUGIN_ERROR_CODES = Object.keys(PLUGIN_ERROR_STATUS) as PluginErrorCode[];
/** Errors the CLI reports locally (no HTTP status): `plugin add` / `plugin update` (§7). */
export const PLUGIN_CLI_ERROR_CODES = ['server_too_old', 'api_too_old', 'unsupported_schema', 'invalid_manifest'] as const;
export type PluginCliErrorCode = typeof PLUGIN_CLI_ERROR_CODES[number];

/** `{ error, message, ...details }`. Details: `issues[]`, `permission`, `currentVersion`, `limit`, `retryAfterMs`, `queued`. */
export const PluginErrorBodySchema = z.object({
    error: z.string(),
    message: z.string().optional(),
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }).passthrough()).optional(),
    permission: z.string().optional(),
    currentVersion: z.number().optional(),
    limit: z.number().optional(),
    retryAfterMs: z.number().optional(),
    queued: z.boolean().optional(),
}).passthrough();
export type PluginErrorBody = z.infer<typeof PluginErrorBodySchema>;

export function pluginErrorBody(error: PluginErrorCode, message: string, details?: Omit<PluginErrorBody, 'error' | 'message'>): PluginErrorBody {
    return { error, message, ...(details ?? {}) };
}

// ─── Manifest (§2.1) ─────────────────────────────────────────────────────────

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const displayText = (max: number) => z.string().trim().min(1).max(max).refine(v => !CONTROL_OR_BIDI.test(v), 'control or bidi characters are not allowed');
const plainText = (max: number) => z.string().max(max).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v), 'control or bidi characters are not allowed');

// semver 2.0.0 (https://semver.org regex), length-capped.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}️‍⃣]|[\u{E0020}-\u{E007F}])*$/u;

/** A single emoji (≤ 16 UTF-16 units; ZWJ sequences, flags and keycaps allowed). */
export function isPluginEmojiIcon(v: string): boolean {
    if (v.length > 16 || !EMOJI.test(v)) return false;
    // At most one grapheme when the runtime can tell.
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
    if (Seg) return [...new Seg(undefined, { granularity: 'grapheme' }).segment(v)].length === 1;
    return true;
}
export function isPluginIconName(v: string): v is PluginIcon {
    return (PLUGIN_ICONS as readonly string[]).includes(v);
}

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})(\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*)?$/;

export type PluginLoopbackTarget = { host: '127.0.0.1' | '::1'; port: number; path: string };

/**
 * Parse a loopback address from a manifest. `upstream` (`allowPath:false`) is
 * exactly `http://127.0.0.1:<port>` or `http://[::1]:<port>`; a `callback.url`
 * may add a path. Never a hostname (`localhost` included), userinfo, query,
 * fragment, `..` segment, backslash or encoded `/` / `\` / NUL / `.`.
 */
export function parsePluginLoopbackUrl(raw: string, allowPath: boolean): PluginLoopbackTarget | null {
    if (typeof raw !== 'string' || raw.length > PLUGIN_LIMITS.pathChars) return null;
    const m = (allowPath ? LOOPBACK_URL : LOOPBACK_ORIGIN).exec(raw);
    if (!m) return null;
    const port = Number(m[2]);
    if (!/^[1-9]/.test(m[2]) || port < PLUGIN_LIMITS.portMin || port > PLUGIN_LIMITS.portMax) return null;
    const path = allowPath ? (m[3] ?? '/') : '/';
    if (allowPath) {
        if (/%(?:2[fFeE]|5[cC]|00)/.test(path)) return null;
        if (path.split('/').some(seg => seg === '..' || seg === '.')) return null;
        if (path.startsWith('//')) return null;
    }
    return { host: m[1] === '127.0.0.1' ? '127.0.0.1' : '::1', port, path };
}

const upstream = z.string().refine(v => parsePluginLoopbackUrl(v, false) !== null, 'must be http://127.0.0.1:<port> or http://[::1]:<port> (port 1024-65535, no path)');
const callbackUrl = z.string().refine(v => parsePluginLoopbackUrl(v, true) !== null, 'must be http://127.0.0.1:<port>[/path] or http://[::1]:<port>[/path] (port 1024-65535, no query)');

/**
 * Panel path inside a plugin origin (`entry`, `panelPath`, `frame-ticket` path):
 * starts with `/`, no `//` prefix, no `..`, no backslash or NUL, ≤512.
 * The daemon applies the full request-path rules (§4.6 step 3) with
 * `normalizePluginRequestPath`.
 */
export const PluginPanelPathSchema = z.string().max(PLUGIN_LIMITS.pathChars).refine(v => normalizePluginRequestPath(v) !== null, 'must be an origin-relative path starting with /');

export const PluginPanelSchema = z.object({
    id: z.string().regex(PLUGIN_LIMITS.panelIdPattern),
    title: displayText(PLUGIN_LIMITS.panelTitleChars),
    upstream,
    entry: PluginPanelPathSchema.default('/'),
});
export type PluginPanel = z.infer<typeof PluginPanelSchema>;

const ManifestBaseSchema = z.object({
    schema: z.literal(PLUGIN_MANIFEST_SCHEMA),
    id: z.string().regex(PLUGIN_LIMITS.idPattern),
    name: displayText(PLUGIN_LIMITS.nameChars),
    version: z.string().max(PLUGIN_LIMITS.versionChars).regex(SEMVER, 'semver'),
    description: plainText(PLUGIN_LIMITS.descriptionChars).optional(),
    publisher: z.object({
        name: displayText(PLUGIN_LIMITS.publisherNameChars),
        url: z.string().max(PLUGIN_LIMITS.publisherUrlChars).regex(/^https:\/\/[^\s]+$/, 'https URL').optional(),
    }).optional(),
    icon: z.string().refine(v => isPluginIconName(v) || isPluginEmojiIcon(v), 'a built-in icon name or a single emoji').default(PLUGIN_DEFAULT_ICON),
    minApi: z.number().int().min(1).default(1),
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length)
        .refine(p => new Set(p).size === p.length, 'permissions must be unique'),
    sidebar: z.object({
        title: displayText(PLUGIN_LIMITS.sidebarTitleChars),
        panel: z.string().regex(PLUGIN_LIMITS.panelIdPattern),
    }).optional(),
    panels: z.array(PluginPanelSchema).min(PLUGIN_LIMITS.panels.min).max(PLUGIN_LIMITS.panels.max)
        .refine(p => new Set(p.map(x => x.id)).size === p.length, 'panel ids must be unique').optional(),
    callback: z.object({ url: callbackUrl }).optional(),
    sessionWidget: z.boolean().optional(),
});

/**
 * `vh-plugin/v1` manifest. Parsing strips unknown keys (report them with
 * `pluginManifestUnknownKeys` as a warning) and fills defaults
 * (`icon: puzzle`, `minApi: 1`, `panels[].entry: "/"`).
 * Cross-field rules: a feature field needs its permission and vice versa;
 * `sidebar.panel` names one of `panels`.
 */
export const PluginManifestSchema = ManifestBaseSchema.superRefine((m, ctx) => {
    const has = (p: PluginPermission) => m.permissions.includes(p);
    if (has('sidebar') && !m.sidebar) ctx.addIssue({ code: 'custom', path: ['sidebar'], message: 'sidebar permission needs a sidebar entry' });
    if (m.sidebar && !has('sidebar')) ctx.addIssue({ code: 'custom', path: ['sidebar'], message: 'sidebar entry needs the sidebar permission' });
    if (m.sidebar && !m.panels?.some(p => p.id === m.sidebar!.panel)) ctx.addIssue({ code: 'custom', path: ['sidebar', 'panel'], message: 'sidebar.panel must name one of panels' });
    if (has('panel') && !m.panels) ctx.addIssue({ code: 'custom', path: ['panels'], message: 'panel permission needs panels' });
    if (m.panels && !has('panel')) ctx.addIssue({ code: 'custom', path: ['panels'], message: 'panels need the panel permission' });
    if (has('session.widget') && m.sessionWidget !== true) ctx.addIssue({ code: 'custom', path: ['sessionWidget'], message: 'session.widget permission needs sessionWidget: true' });
    if (m.sessionWidget === true && !has('session.widget')) ctx.addIssue({ code: 'custom', path: ['sessionWidget'], message: 'sessionWidget needs the session.widget permission' });
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;

const KNOWN_MANIFEST_KEYS = new Set(Object.keys(ManifestBaseSchema.shape));
/** Top-level keys the host does not know (ignored; `plugin add` warns). */
export function pluginManifestUnknownKeys(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.keys(raw).filter(k => !KNOWN_MANIFEST_KEYS.has(k)).sort();
}

export type PluginManifestParseResult =
    | { ok: true; manifest: PluginManifest; unknownKeys: string[] }
    | { ok: false; error: 'unsupported_schema' | 'invalid_manifest' | 'payload_too_large'; message: string; issues?: { path: (string | number)[]; message: string }[] };

/** Parse a manifest object: `unsupported_schema` for another major (`vh-plugin/v2`, missing), otherwise the zod issues. */
export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
    const schema = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).schema : undefined;
    if (schema !== PLUGIN_MANIFEST_SCHEMA) {
        return { ok: false, error: 'unsupported_schema', message: `unsupported manifest schema ${JSON.stringify(schema ?? null)}; expected ${PLUGIN_MANIFEST_SCHEMA}` };
    }
    const parsed = PluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false, error: 'invalid_manifest', message: 'invalid manifest',
            issues: parsed.error.issues.map(i => ({ path: i.path.map(p => (typeof p === 'symbol' ? String(p) : p)), message: i.message })),
        };
    }
    return { ok: true, manifest: parsed.data, unknownKeys: pluginManifestUnknownKeys(raw) };
}

/** Parse manifest file text (UTF-8, ≤32KB). */
export function parsePluginManifestJson(text: string): PluginManifestParseResult {
    if (new TextEncoder().encode(text).length > PLUGIN_LIMITS.manifestBytes) {
        return { ok: false, error: 'payload_too_large', message: `manifest exceeds ${PLUGIN_LIMITS.manifestBytes} bytes` };
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) {
        return { ok: false, error: 'invalid_manifest', message: `manifest is not JSON: ${(e as Error).message}` };
    }
    return parsePluginManifest(raw);
}

// ─── Hashes (§2.1, §3.3) ─────────────────────────────────────────────────────

/**
 * `manifestHash` = sha256 hex of the canonical JSON of the **parsed** manifest
 * (unknown keys stripped, defaults filled, keys sorted, no whitespace).
 * The server, daemon and Web all hash the parsed form, so an omitted default
 * and the explicit default hash the same.
 */
export function pluginManifestHash(manifest: PluginManifest): string {
    return pluginSha256Hex(pluginCanonicalJson(manifest));
}

/**
 * The identity and privilege fields whose change needs re-approval: `id`,
 * `name`, `icon`, `permissions` (as a sorted set), `panels[].id` +
 * `panels[].upstream` (sorted by id), `callback.url`, `sidebar.panel`,
 * `sessionWidget`. Absent values are `null` (`sessionWidget` absent = false).
 */
export function pluginPrivilegedView(m: PluginManifest) {
    return {
        id: m.id,
        name: m.name,
        icon: m.icon ?? PLUGIN_DEFAULT_ICON,
        permissions: [...m.permissions].sort(),
        panels: (m.panels ?? []).map(p => ({ id: p.id, upstream: p.upstream })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        callbackUrl: m.callback?.url ?? null,
        sidebarPanel: m.sidebar?.panel ?? null,
        sessionWidget: m.sessionWidget === true,
    };
}
export type PluginPrivilegedView = ReturnType<typeof pluginPrivilegedView>;

/** `privilegedHash` = sha256 hex of the canonical JSON of `pluginPrivilegedView`. */
export function pluginPrivilegedHash(manifest: PluginManifest): string {
    return pluginSha256Hex(pluginCanonicalJson(pluginPrivilegedView(manifest)));
}

export type PluginPrivilegedChange = {
    field: 'id' | 'name' | 'icon' | 'permission' | 'panel' | 'upstream' | 'callback' | 'sidebarPanel' | 'sessionWidget';
    change: 'added' | 'removed' | 'changed';
    /** Panel id or permission name, when the change is about one entry. */
    ref?: string;
    before?: string | boolean | null;
    after?: string | boolean | null;
    /** false only for reductions (a permission, panel, callback or session widget dropped), which apply immediately. */
    requiresApproval: boolean;
};

/** Line-by-line privileged diff for the review page (§3.2, §3.3). Empty when `privilegedHash` is equal. */
export function pluginPrivilegedDiff(approved: PluginManifest, next: PluginManifest): PluginPrivilegedChange[] {
    const a = pluginPrivilegedView(approved), b = pluginPrivilegedView(next);
    const out: PluginPrivilegedChange[] = [];
    for (const f of ['id', 'name', 'icon'] as const) {
        if (a[f] !== b[f]) out.push({ field: f, change: 'changed', before: a[f], after: b[f], requiresApproval: true });
    }
    for (const p of b.permissions) if (!a.permissions.includes(p)) out.push({ field: 'permission', change: 'added', ref: p, after: p, requiresApproval: true });
    for (const p of a.permissions) if (!b.permissions.includes(p)) out.push({ field: 'permission', change: 'removed', ref: p, before: p, requiresApproval: false });
    for (const p of b.panels) {
        const old = a.panels.find(x => x.id === p.id);
        if (!old) out.push({ field: 'panel', change: 'added', ref: p.id, after: p.upstream, requiresApproval: true });
        else if (old.upstream !== p.upstream) out.push({ field: 'upstream', change: 'changed', ref: p.id, before: old.upstream, after: p.upstream, requiresApproval: true });
    }
    for (const p of a.panels) if (!b.panels.some(x => x.id === p.id)) out.push({ field: 'panel', change: 'removed', ref: p.id, before: p.upstream, requiresApproval: false });
    if (a.callbackUrl !== b.callbackUrl) {
        const change = a.callbackUrl === null ? 'added' : b.callbackUrl === null ? 'removed' : 'changed';
        out.push({ field: 'callback', change, before: a.callbackUrl, after: b.callbackUrl, requiresApproval: change !== 'removed' });
    }
    if (a.sidebarPanel !== b.sidebarPanel) {
        const change = a.sidebarPanel === null ? 'added' : b.sidebarPanel === null ? 'removed' : 'changed';
        out.push({ field: 'sidebarPanel', change, before: a.sidebarPanel, after: b.sidebarPanel, requiresApproval: change !== 'removed' });
    }
    if (a.sessionWidget !== b.sessionWidget) {
        out.push({ field: 'sessionWidget', change: b.sessionWidget ? 'added' : 'removed', before: a.sessionWidget, after: b.sessionWidget, requiresApproval: b.sessionWidget });
    }
    return out;
}

/** True when `plugin update` must go to `update_pending` (any privileged change that is not a pure reduction). */
export function pluginUpdateNeedsApproval(approved: PluginManifest, next: PluginManifest): boolean {
    if (pluginPrivilegedHash(approved) === pluginPrivilegedHash(next)) return false;
    return pluginPrivilegedDiff(approved, next).some(c => c.requiresApproval);
}

// ─── Per-install origin (§4.1) ───────────────────────────────────────────────

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** `<h8>`: first 8 characters of the lowercase RFC 4648 base32 of `sha256(installId)` (no padding). */
export function pluginInstallHash8(installId: string): string {
    const hex = pluginSha256Hex(installId);
    // 8 base32 chars = 40 bits = first 5 bytes.
    let bits = parseInt(hex.slice(0, 10), 16); // < 2^40, exact in a double
    let out = '';
    for (let i = 0; i < 8; i++) {
        out = BASE32[bits % 32] + out;
        bits = Math.floor(bits / 32);
    }
    return out;
}
/** Plugin subdomain label `<pluginId>-<h8>`. */
export function pluginOriginLabel(pluginId: string, installId: string): string {
    return `${pluginId}-${pluginInstallHash8(installId)}`;
}
/** `https://<pluginId>-<h8>.<pluginHost>`. */
export function pluginOrigin(pluginId: string, installId: string, pluginHost: string): string {
    return `https://${pluginOriginLabel(pluginId, installId)}.${pluginHost}`;
}

// ─── Request path rules (§4.6 step 3) ────────────────────────────────────────

/**
 * Normalize a forwarded request path (`path` may carry `?query`). Returns the
 * path to send upstream, or null for `invalid_path`: not starting with `/`,
 * `//host` or `scheme:` forms, backslash, NUL or control characters (raw or
 * percent-encoded), `.` / `..` segments after percent-decoding, or malformed
 * percent-encoding. The returned string is the original (still encoded) path.
 */
export function normalizePluginRequestPath(raw: string): string | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
    const q = raw.indexOf('?');
    const path = q === -1 ? raw : raw.slice(0, q);
    const query = q === -1 ? '' : raw.slice(q);
    if (!path.startsWith('/')) return null;
    if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return null; }
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')) return null;
    if (decoded.split('/').some(seg => seg === '..' || seg === '.')) return null;
    if (/%(?:00|5[cC])/.test(query)) return null;
    return path + query;
}

// ─── /plugin/v1: info and badge (§5.2) ───────────────────────────────────────

export type PluginInfoResponse = {
    apiVersion: number;
    features: string[];
    installId: string;
    pluginId: string;
    state: string;
    grants: string[];
    machineId: string;
};
export const PluginInfoResponseSchema = z.object({
    apiVersion: z.number(),
    features: z.array(z.string()),
    installId: z.string(),
    pluginId: z.string(),
    state: z.string(),
    grants: z.array(z.string()),
    machineId: z.string(),
}).passthrough();

export const PLUGIN_BADGE_TONES = ['default', 'attention'] as const;
export type PluginBadgeTone = typeof PLUGIN_BADGE_TONES[number];
/** PUT /plugin/v1/badge. `count: null` clears it. */
export const PluginBadgePutSchema = z.object({
    count: z.number().int().min(0).max(PLUGIN_LIMITS.badgeCountMax).nullable(),
    tone: z.enum(PLUGIN_BADGE_TONES).optional(),
    label: displayText(PLUGIN_LIMITS.badgeLabelChars).optional(),
});
export type PluginBadgePut = z.infer<typeof PluginBadgePutSchema>;
export const PluginBadgeSchema = z.object({
    count: z.number().nullable(),
    tone: z.string(),
    label: z.string().nullable().optional(),
    updatedAt: z.number(),
}).passthrough();
export type PluginBadge = z.infer<typeof PluginBadgeSchema>;
export type PluginBadgeResponse = { badge: PluginBadge };
/** Display text for a count (`99+` above 99); null when there is no badge. */
export function pluginBadgeText(count: number | null | undefined): string | null {
    if (count === null || count === undefined || count <= 0) return null;
    return count > 99 ? '99+' : String(count);
}
/** Whether a badge adds to the global app badge (§11 Q5: `tone: attention` only, unless the owner muted the plugin). */
export function pluginBadgeCountsGlobally(badge: { count: number | null; tone: string } | null | undefined, muted: boolean): number {
    if (!badge || muted || badge.tone !== 'attention' || !badge.count || badge.count <= 0) return 0;
    return badge.count;
}

// ─── /plugin/v1: decisions (§5.3) ────────────────────────────────────────────

export const PLUGIN_DECISION_KINDS = ['choice', 'input', 'notice'] as const;
export type PluginDecisionKind = typeof PLUGIN_DECISION_KINDS[number];
export const PLUGIN_DECISION_STATES = ['open', 'responded', 'closed'] as const;
export type PluginDecisionState = typeof PLUGIN_DECISION_STATES[number];
export const PLUGIN_DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const;
export const PLUGIN_DECISION_CLOSE_OUTCOMES = ['done', 'dropped', 'superseded'] as const;
export const PLUGIN_OPTION_STYLES = ['default', 'primary', 'danger'] as const;
/** What the owner did: pressed an option, submitted text, or dismissed (「知道了」). */
export const PLUGIN_RESPONSE_ACTIONS = ['choose', 'submit', 'dismiss'] as const;
export type PluginResponseAction = typeof PLUGIN_RESPONSE_ACTIONS[number];
/** AttentionItem `kind` a plugin decision is stored as (§5.3 落库). */
export const PLUGIN_DECISION_ATTENTION_KIND: Record<PluginDecisionKind, 'decision' | 'input' | 'report'> = {
    choice: 'decision',
    input: 'input',
    notice: 'report',
};

const decisionBody = z.string().max(PLUGIN_LIMITS.decisionBodyBytes * 4)
    .refine(v => new TextEncoder().encode(v).length <= PLUGIN_LIMITS.decisionBodyBytes, 'bodyMd exceeds 8KB');
export const PluginDecisionOptionSchema = z.object({
    id: z.string().regex(PLUGIN_LIMITS.optionIdPattern),
    label: displayText(PLUGIN_LIMITS.decisionOptionLabelChars),
    style: z.enum(PLUGIN_OPTION_STYLES).optional(),
    detail: plainText(PLUGIN_LIMITS.decisionOptionDetailChars).optional(),
});
export type PluginDecisionOption = z.infer<typeof PluginDecisionOptionSchema>;
const decisionOptions = z.array(PluginDecisionOptionSchema).min(PLUGIN_LIMITS.decisionOptions.min).max(PLUGIN_LIMITS.decisionOptions.max)
    .refine(o => new Set(o.map(x => x.id)).size === o.length, 'option ids must be unique');
export const PluginDecisionInputSpecSchema = z.object({
    placeholder: plainText(PLUGIN_LIMITS.inputPlaceholderChars).optional(),
    maxLength: z.number().int().min(1).max(PLUGIN_LIMITS.inputMaxLength).optional(),
    multiline: z.boolean().optional(),
});
export type PluginDecisionInputSpec = z.infer<typeof PluginDecisionInputSpecSchema>;
const decisionKey = z.string().min(1).max(PLUGIN_LIMITS.decisionKeyChars);
const sessionIdField = z.string().min(1).max(128);

/**
 * POST /plugin/v1/decisions. Upsert by `key`: an existing key updates the item;
 * a closed one reopens. `choice` needs 2–4 `options`, `input` needs `input`,
 * `notice` takes neither. Permissions: `decisions`; `sessionId` also needs
 * `session.widget` or `sessions.list`; `panelPath` also needs `panel`
 * (`pluginDecisionRequiredPermissions`).
 */
export const PluginDecisionPostSchema = z.object({
    key: decisionKey,
    kind: z.enum(PLUGIN_DECISION_KINDS),
    title: displayText(PLUGIN_LIMITS.decisionTitleChars),
    bodyMd: decisionBody.optional(),
    options: decisionOptions.optional(),
    input: PluginDecisionInputSpecSchema.optional(),
    sessionId: sessionIdField.optional(),
    panelPath: PluginPanelPathSchema.optional(),
    push: z.boolean().default(true),
}).superRefine((d, ctx) => {
    if (d.kind === 'choice' && !d.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'choice needs 2-4 options' });
    if (d.kind !== 'choice' && d.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'options are only for choice' });
    if (d.kind === 'input' && !d.input) ctx.addIssue({ code: 'custom', path: ['input'], message: 'input needs an input spec' });
    if (d.kind !== 'input' && d.input) ctx.addIssue({ code: 'custom', path: ['input'], message: 'input spec is only for input' });
});
export type PluginDecisionPost = z.infer<typeof PluginDecisionPostSchema>;
export type PluginDecisionPostInput = z.input<typeof PluginDecisionPostSchema>;

/** PATCH /plugin/v1/decisions/:key. `kind` cannot change; `options` / `input` must still fit the kind (server checks against the stored kind). */
export const PluginDecisionPatchSchema = z.object({
    title: displayText(PLUGIN_LIMITS.decisionTitleChars).optional(),
    bodyMd: decisionBody.nullable().optional(),
    options: decisionOptions.optional(),
    input: PluginDecisionInputSpecSchema.optional(),
    panelPath: PluginPanelPathSchema.nullable().optional(),
    /** Reopen a `responded` item for another response. */
    reopen: z.boolean().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
});
export type PluginDecisionPatch = z.infer<typeof PluginDecisionPatchSchema>;

/** DELETE /plugin/v1/decisions/:key (plugin-side close). Body optional. */
export const PluginDecisionDeleteSchema = z.object({
    outcome: z.enum(PLUGIN_DECISION_CLOSE_OUTCOMES).optional(),
    note: plainText(PLUGIN_LIMITS.decisionNoteChars).optional(),
});
export type PluginDecisionDelete = z.infer<typeof PluginDecisionDeleteSchema>;

export const PluginDecisionListQuerySchema = z.object({
    state: z.enum(['open', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(PLUGIN_LIMITS.decisionListMax).optional(),
});
export type PluginDecisionListQuery = z.infer<typeof PluginDecisionListQuerySchema>;

export const PluginDecisionResponseSchema = z.object({
    action: z.string(),
    choice: z.string().optional(),
    text: z.string().optional(),
    note: z.string().optional(),
    at: z.number(),
}).passthrough();
export type PluginDecisionResponse = z.infer<typeof PluginDecisionResponseSchema>;

/** `PluginDecision` as `/plugin/v1/decisions*` returns it. */
export const PluginDecisionSchema = z.object({
    itemId: z.string(),
    key: z.string(),
    kind: z.string(),
    title: z.string(),
    bodyMd: z.string().nullable(),
    options: z.array(z.object({ id: z.string(), label: z.string(), style: z.string().optional(), detail: z.string().optional() }).passthrough()).nullable(),
    input: z.object({ placeholder: z.string().optional(), maxLength: z.number().optional(), multiline: z.boolean().optional() }).passthrough().nullable(),
    sessionId: z.string().nullable().optional(),
    panelPath: z.string().nullable().optional(),
    state: z.string(),
    response: PluginDecisionResponseSchema.nullable().optional(),
    delivery: z.string(),
    version: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
}).passthrough();
export type PluginDecision = z.infer<typeof PluginDecisionSchema>;
export type PluginDecisionPostResponse = { item: PluginDecision; created: boolean };
export type PluginDecisionItemResponse = { item: PluginDecision };
export type PluginDecisionListResponse = { items: PluginDecision[] };

/** Every permission a decision post needs (each must be granted; `sessionId` accepts either of two). */
export function pluginDecisionRequiredPermissions(d: { sessionId?: string; panelPath?: string | null }): { all: PluginPermission[]; anyOf: PluginPermission[][] } {
    const all: PluginPermission[] = ['decisions'];
    const anyOf: PluginPermission[][] = [];
    if (d.sessionId) anyOf.push(['session.widget', 'sessions.list']);
    if (d.panelPath) all.push('panel');
    return { all, anyOf };
}
/** First missing permission for a decision write, or null. */
export function pluginDecisionMissingPermission(d: { sessionId?: string; panelPath?: string | null }, grants: readonly string[]): PluginPermission | null {
    const req = pluginDecisionRequiredPermissions(d);
    for (const p of req.all) if (!grants.includes(p)) return p;
    for (const group of req.anyOf) if (!group.some(p => grants.includes(p))) return group[0];
    return null;
}

// ─── /plugin/v1: session widget (§5.4) ───────────────────────────────────────

export const PLUGIN_WIDGET_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
export type PluginWidgetTone = typeof PLUGIN_WIDGET_TONES[number];
export const PluginWidgetActionSchema = z.object({
    id: z.string().regex(PLUGIN_LIMITS.optionIdPattern),
    label: displayText(PLUGIN_LIMITS.widgetActionLabelChars),
    style: z.enum(PLUGIN_OPTION_STYLES).optional(),
    confirm: plainText(PLUGIN_LIMITS.widgetConfirmChars).optional(),
});
/** PUT /plugin/v1/sessions/:sessionId/widget. Needs `session.widget`; `panelPath` also needs `panel`. */
export const PluginWidgetPutSchema = z.object({
    status: z.object({
        label: displayText(PLUGIN_LIMITS.widgetLabelChars),
        tone: z.enum(PLUGIN_WIDGET_TONES),
    }),
    text: plainText(PLUGIN_LIMITS.widgetTextChars).optional(),
    actions: z.array(PluginWidgetActionSchema).max(PLUGIN_LIMITS.widgetActions)
        .refine(a => new Set(a.map(x => x.id)).size === a.length, 'action ids must be unique').optional(),
    panelPath: PluginPanelPathSchema.optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
});
export type PluginWidgetPut = z.infer<typeof PluginWidgetPutSchema>;
export const PluginWidgetSchema = z.object({
    sessionId: z.string(),
    status: z.object({ label: z.string(), tone: z.string() }).passthrough(),
    text: z.string().nullable().optional(),
    actions: z.array(z.object({ id: z.string(), label: z.string(), style: z.string().optional(), confirm: z.string().optional() }).passthrough()),
    panelPath: z.string().nullable().optional(),
    version: z.number(),
    updatedAt: z.number(),
}).passthrough();
export type PluginWidget = z.infer<typeof PluginWidgetSchema>;
export type PluginWidgetResponse = { widget: PluginWidget };
export type PluginWidgetDeleteResponse = { removed: true };

// ─── /plugin/v1: sensitive reads (§5.7) ──────────────────────────────────────

export const PluginSessionsListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(PLUGIN_LIMITS.sessionsListMax).optional(),
    cursor: z.string().max(512).optional(),
});
export const PluginSessionMessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(PLUGIN_LIMITS.sessionMessagesMax).optional(),
    before: z.string().max(512).optional(),
});
export const PLUGIN_SESSION_STATUSES = ['running', 'idle', 'archived'] as const;
export type PluginSessionSummary = { id: string; title: string | null; cwd: string | null; agent: string | null; status: string; updatedAt: number };
export type PluginSessionsListResponse = { sessions: PluginSessionSummary[]; cursor: string | null };
export type PluginSessionMessage = { id: string; role: 'user' | 'agent'; text: string; createdAt: number };
export type PluginSessionMessagesResponse = { messages: PluginSessionMessage[]; cursor: string | null };

// ─── Events and callbacks (§5.5) ─────────────────────────────────────────────

export const PLUGIN_EVENT_TYPES = ['decision.responded', 'widget.action', 'install.changed', 'ping'] as const;
export type PluginEventType = typeof PLUGIN_EVENT_TYPES[number];
/** Push delivery headers. */
export const PLUGIN_HEADERS = {
    eventId: 'X-VH-Event-Id',
    timestamp: 'X-VH-Timestamp',
    signature: 'X-VH-Signature',
    install: 'X-VH-Install',
    requestId: 'X-VH-Request-Id',
    viewer: 'X-VH-Viewer',
} as const;
/** Retry delays after a failed push (ms); then every 6 h until 24 h after the first attempt, then `failed`. */
export const PLUGIN_EVENT_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000] as const;
export const PLUGIN_EVENT_RETRY_TAIL_MS = 6 * 60 * 60 * 1000;
export const PLUGIN_EVENT_GIVE_UP_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_EVENT_DELIVERY_TIMEOUT_MS = 10_000;
/** Plugins should remember event ids at least this long for dedupe. */
export const PLUGIN_EVENT_DEDUPE_MS = 10 * 60 * 1000;

/** Delay before retry number `attempt` (1-based count of failed attempts so far), or null to give up. */
export function pluginEventRetryDelayMs(failedAttempts: number, firstAttemptAt: number, now: number): number | null {
    if (failedAttempts < 1) return 0;
    const delay = failedAttempts <= PLUGIN_EVENT_RETRY_DELAYS_MS.length ? PLUGIN_EVENT_RETRY_DELAYS_MS[failedAttempts - 1] : PLUGIN_EVENT_RETRY_TAIL_MS;
    return now + delay - firstAttemptAt > PLUGIN_EVENT_GIVE_UP_MS ? null : delay;
}

export const PluginDecisionRespondedDataSchema = z.object({
    itemId: z.string(),
    key: z.string(),
    action: z.enum(PLUGIN_RESPONSE_ACTIONS),
    choice: z.string().optional(),
    text: z.string().optional(),
    note: z.string().optional(),
    respondedAt: z.number(),
    actor: z.literal('owner'),
});
export const PluginWidgetActionDataSchema = z.object({
    sessionId: z.string(),
    actionId: z.string(),
    at: z.number(),
    actor: z.literal('owner'),
});
export const PluginInstallChangedDataSchema = z.object({
    state: z.string(),
    grants: z.array(z.string()),
    manifestHash: z.string(),
});
export const PluginPingDataSchema = z.object({}).passthrough();

const envelopeBase = {
    id: z.string().min(1).max(128),
    installId: z.string().min(1).max(128),
    pluginId: z.string(),
    createdAt: z.number(),
    attempt: z.number().int().min(1),
};
/** Strict envelope for the known event types (what the host emits). */
export const PluginEventSchema = z.discriminatedUnion('type', [
    z.object({ ...envelopeBase, type: z.literal('decision.responded'), data: PluginDecisionRespondedDataSchema }),
    z.object({ ...envelopeBase, type: z.literal('widget.action'), data: PluginWidgetActionDataSchema }),
    z.object({ ...envelopeBase, type: z.literal('install.changed'), data: PluginInstallChangedDataSchema }),
    z.object({ ...envelopeBase, type: z.literal('ping'), data: PluginPingDataSchema }),
]);
export type PluginEvent = z.infer<typeof PluginEventSchema>;
/** Lenient read for plugin code: unknown future types stay readable (`type` an open string). */
export const PluginEventReadSchema = z.object({ ...envelopeBase, type: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough();

/** GET /plugin/v1/events (`after` cursor, `wait` long-poll seconds). */
export const PluginEventsPullQuerySchema = z.object({
    after: z.string().max(256).optional(),
    wait: z.coerce.number().int().min(0).max(PLUGIN_LIMITS.eventsWaitMaxSec).optional(),
});
/**
 * A pulled event carries the same signature a push would: `signature` over
 * `rawBody` (the exact JSON text of `event`) at `timestamp`.
 */
export type PluginPulledEvent = { event: PluginEvent; rawBody: string; timestamp: number; signature: string };
export type PluginEventsPullResponse = { events: PluginPulledEvent[]; cursor: string | null };
export const PluginEventsAckSchema = z.object({ upTo: z.string().min(1).max(256) });
export type PluginEventsAckResponse = { acked: number };

// ─── daemon ↔ server: plugin-op (§5.6) ───────────────────────────────────────

export const PLUGIN_OPS = [
    'badge.put',
    'decision.post', 'decision.patch', 'decision.delete', 'decision.list',
    'widget.put', 'widget.delete', 'widget.get',
    'events.pull', 'events.ack',
    'install.disable', 'install.remove', 'install.seen',
] as const;
export type PluginOp = typeof PLUGIN_OPS[number];
/**
 * Base permission each op needs (server checks `∈ grants` with the *current*
 * grants). Decision ops add `pluginDecisionMissingPermission`; widget ops with
 * `panelPath` add `panel`. `null` = no grant needed (install lifecycle, own events).
 */
export const PLUGIN_OP_PERMISSION: Record<PluginOp, PluginPermission | null> = {
    'badge.put': 'sidebar',
    'decision.post': 'decisions',
    'decision.patch': 'decisions',
    'decision.delete': 'decisions',
    'decision.list': 'decisions',
    'widget.put': 'session.widget',
    'widget.delete': 'session.widget',
    'widget.get': 'session.widget',
    'events.pull': null,
    'events.ack': null,
    'install.disable': null,
    'install.remove': null,
    'install.seen': null,
};
/** Socket event `plugin-op` (machine-scoped socket) → ack `PluginOpResult`. `requestId` doubles as the idempotency key. */
export const PluginOpRequestSchema = z.object({
    installId: z.string().min(1).max(128),
    op: z.enum(PLUGIN_OPS),
    /** Route params (`key`, `sessionId`) plus the validated request body / query. */
    payload: z.record(z.string(), z.unknown()),
    requestId: z.string().min(1).max(PLUGIN_LIMITS.idempotencyKeyChars),
});
export type PluginOpRequest = z.infer<typeof PluginOpRequestSchema>;
export type PluginOpResult =
    | { ok: true; status: number; body: unknown }
    | { ok: false; status: number; body: PluginErrorBody };

// ─── server ↔ daemon: plugin-http (§4.5) ─────────────────────────────────────

export const PLUGIN_HTTP_LIMITS = {
    inlineRequestBodyBytes: 256 * 1024,
    requestChunkBytes: 512 * 1024,
    requestTotalBytes: 8 * 1024 * 1024,
    responseChunkBytes: 512 * 1024,
    responseTotalBytes: 32 * 1024 * 1024,
    totalTimeoutMs: 30_000,
    chunkTimeoutMs: 10_000,
    daemonRequestTimeoutMs: 25_000,
} as const;
export const PLUGIN_HTTP_RPC = {
    request: 'plugin-http',
    requestBody: 'plugin-http-body',
    responsePull: 'plugin-http-pull',
} as const;
const headerMap = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
export const PluginHttpRequestSchema = z.object({
    reqId: z.string().min(1).max(128),
    installId: z.string().min(1).max(128),
    panelId: z.string().regex(PLUGIN_LIMITS.panelIdPattern),
    method: z.string().regex(/^[A-Z]{1,16}$/),
    path: z.string().min(1).max(8192),
    query: z.string().max(8192).optional(),
    headers: headerMap,
    bodyB64: z.string().optional(),
    bodyStreamId: z.string().min(1).max(128).optional(),
}).refine(r => !(r.bodyB64 !== undefined && r.bodyStreamId !== undefined), 'bodyB64 or bodyStreamId, not both');
export type PluginHttpRequest = z.infer<typeof PluginHttpRequestSchema>;
export const PluginHttpBodyChunkSchema = z.object({
    streamId: z.string().min(1).max(128),
    seq: z.number().int().min(0),
    chunkB64: z.string(),
    end: z.boolean(),
});
export const PluginHttpResponseSchema = z.object({
    status: z.number().int().min(100).max(599),
    headers: headerMap,
    bodyB64: z.string(),
    /** More body to pull with `plugin-http-pull`. */
    streamId: z.string().min(1).max(128).optional(),
});
export type PluginHttpResponse = z.infer<typeof PluginHttpResponseSchema>;
export const PluginHttpPullSchema = z.object({ streamId: z.string().min(1).max(128), seq: z.number().int().min(1) });
export const PluginHttpPullResponseSchema = z.object({ chunkB64: z.string(), end: z.boolean() });

// ─── Web ↔ server (§5.8, host-internal) ──────────────────────────────────────

export const PluginInstallCreateSchema = z.object({ manifest: z.unknown() });
export type PluginInstallCreateResponse = { installId: string; state: string; reviewUrl: string; manifestHash: string };
export const PluginInstallApproveSchema = z.object({
    grants: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).refine(g => new Set(g).size === g.length, 'grants must be unique'),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PluginInstallApprove = z.infer<typeof PluginInstallApproveSchema>;
export const PluginInstallDisableSchema = z.object({ reason: plainText(PLUGIN_LIMITS.reasonChars).optional() });
export const PluginInstallRevokeSchema = z.object({
    revoke: z.array(z.enum(PLUGIN_PERMISSIONS)).min(1).max(PLUGIN_PERMISSIONS.length),
});
export const PluginFrameTicketRequestSchema = z.object({
    panelId: z.string().regex(PLUGIN_LIMITS.panelIdPattern),
    path: PluginPanelPathSchema.optional(),
});
export type PluginFrameTicketResponse = { ticket: string; url: string; origin: string };
export const PLUGIN_FRAME_TICKET_TTL_MS = 60_000;
export const PLUGIN_FRAME_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const PluginWidgetActionRequestSchema = z.object({ actionId: z.string().regex(PLUGIN_LIMITS.optionIdPattern) });
export type PluginWidgetActionResponse = { eventId: string };
/** Owner mute (§11 Q5): per plugin install, stops push and the global badge contribution. */
export const PluginInstallMuteSchema = z.object({ muted: z.boolean() });

/** One privileged change, as the review page lists it. */
export const PluginPendingDiffEntrySchema = z.object({
    field: z.string(),
    change: z.string(),
    ref: z.string().optional(),
    before: z.union([z.string(), z.boolean()]).nullable().optional(),
    after: z.union([z.string(), z.boolean()]).nullable().optional(),
    requiresApproval: z.boolean(),
}).passthrough();

/** `PluginInstallView`: never includes upstream ports, callback URL, token or secret. */
export const PluginInstallViewSchema = z.object({
    id: z.string(),
    machineId: z.string(),
    pluginId: z.string(),
    name: z.string(),
    icon: z.string(),
    version: z.string(),
    description: z.string().nullable().optional(),
    publisher: z.object({ name: z.string(), url: z.string().optional() }).passthrough().nullable().optional(),
    state: z.string(),
    stateReason: z.string().nullable().optional(),
    grants: z.array(z.string()),
    /** Permissions the approved (or pending) manifest asks for. */
    requested: z.array(z.string()).optional(),
    manifestHash: z.string().optional(),
    pendingManifestHash: z.string().nullable().optional(),
    pendingDiff: z.array(PluginPendingDiffEntrySchema).nullable().optional(),
    sidebar: z.object({ title: z.string(), panel: z.string() }).passthrough().nullable().optional(),
    panels: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()),
    sessionWidget: z.boolean().optional(),
    hasCallback: z.boolean().optional(),
    badge: PluginBadgeSchema.nullable().optional(),
    muted: z.boolean().optional(),
    /** `https://<pluginId>-<h8>.<pluginHost>`; null when the server has no plugin host (panels unavailable). */
    origin: z.string().nullable(),
    lastSeenAt: z.number().nullable(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
}).passthrough();
export type PluginInstallView = z.infer<typeof PluginInstallViewSchema>;
export type PluginInstallListResponse = { installs: PluginInstallView[] };
export type PluginInstallResponse = { install: PluginInstallView };

/** Socket `update` bodies. */
export const UpdatePluginInstallBodySchema = z.object({ t: z.literal('plugin-install'), install: PluginInstallViewSchema });
export const UpdatePluginWidgetBodySchema = z.object({
    t: z.literal('plugin-widget'),
    installId: z.string(),
    sessionId: z.string(),
    /** null = removed or hidden. */
    widget: PluginWidgetSchema.nullable(),
});
export type UpdatePluginInstallBody = z.infer<typeof UpdatePluginInstallBodySchema>;
export type UpdatePluginWidgetBody = z.infer<typeof UpdatePluginWidgetBodySchema>;

export const PluginAuditEntrySchema = z.object({
    id: z.string(),
    installId: z.string(),
    actor: z.string(),
    action: z.string(),
    requestId: z.string().nullable().optional(),
    detail: z.string().nullable().optional(),
    createdAt: z.number(),
}).passthrough();
export type PluginAuditEntry = z.infer<typeof PluginAuditEntrySchema>;

// ─── postMessage bridge (§4.4) ───────────────────────────────────────────────

export const PLUGIN_BRIDGE_METHODS = ['host.hello', 'host.theme.subscribe', 'host.setTitle', 'host.navigate', 'host.openExternal', 'host.badge.refresh'] as const;
export type PluginBridgeMethod = typeof PLUGIN_BRIDGE_METHODS[number];
export const PluginBridgeRequestSchema = z.discriminatedUnion('method', [
    z.object({ vh: z.literal(1), id: z.union([z.string().max(64), z.number()]), method: z.literal('host.hello'), params: z.object({}).passthrough().optional() }),
    z.object({ vh: z.literal(1), id: z.union([z.string().max(64), z.number()]), method: z.literal('host.theme.subscribe'), params: z.object({}).passthrough().optional() }),
    z.object({ vh: z.literal(1), id: z.union([z.string().max(64), z.number()]), method: z.literal('host.setTitle'), params: z.object({ title: displayText(PLUGIN_LIMITS.panelTitleChars) }) }),
    z.object({
        vh: z.literal(1), id: z.union([z.string().max(64), z.number()]), method: z.literal('host.navigate'),
        params: z.discriminatedUnion('to', [
            z.object({ to: z.literal('panel'), panelId: z.string().regex(PLUGIN_LIMITS.panelIdPattern), path: PluginPanelPathSchema.optional() }),
            z.object({ to: z.literal('session'), sessionId: sessionIdField }),
        ]),
    }),
    z.object({ vh: z.literal(1), id: z.union([z.string().max(64), z.number()]), method: z.literal('host.openExternal'), params: z.object({ url: z.string().max(2048).regex(/^https:\/\/[^\s]+$/, 'https only') }) }),
    z.object({ vh: z.literal(1), id: z.union([z.string().max(64), z.number()]), method: z.literal('host.badge.refresh'), params: z.object({}).passthrough().optional() }),
]);
export type PluginBridgeRequest = z.infer<typeof PluginBridgeRequestSchema>;
export type PluginBridgeReply = { vh: 1; id: string | number; ok: true; result: unknown } | { vh: 1; id: string | number; ok: false; error: { code: string; message?: string } };
/** Host push (no `id`): `host.themeChanged`. */
export type PluginBridgeEvent = { vh: 1; event: 'host.themeChanged'; params: { theme: 'light' | 'dark' } };
export type PluginBridgeHello = { apiVersion: number; theme: 'light' | 'dark'; locale: string; installId: string; panelId: string; mobile: boolean };
/** Permissions a bridge call needs (checked against the *current* grants on every call). */
export function pluginBridgeRequiredPermissions(req: PluginBridgeRequest): PluginPermission[] {
    if (req.method === 'host.badge.refresh') return ['sidebar'];
    if (req.method === 'host.navigate' && req.params.to === 'session') return ['panel', 'session.widget'];
    return ['panel'];
}
