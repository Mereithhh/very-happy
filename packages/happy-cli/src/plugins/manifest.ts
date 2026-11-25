/**
 * B-974c: the `vh-plugin/v1` manifest as the CLI and daemon use it. The
 * schema, hashes and loopback rule come from `@slopus/happy-wire` (B-974a);
 * this file only adapts them to the CLI's error codes (§7).
 */
import {
    PLUGIN_API_VERSION,
    PLUGIN_LIMITS,
    PLUGIN_PERMISSIONS,
    PLUGIN_SENSITIVE_PERMISSIONS,
    PluginManifestSchema,
    parsePluginLoopbackUrl,
    parsePluginManifestJson,
    pluginManifestHash,
    pluginPrivilegedHash,
    type PluginManifest,
    type PluginPermission,
} from '@slopus/happy-wire';

export { PLUGIN_PERMISSIONS, PluginManifestSchema, type PluginManifest, type PluginPermission };
export const SENSITIVE_PLUGIN_PERMISSIONS = PLUGIN_SENSITIVE_PERMISSIONS;
/** The `/plugin/v1` feature level this daemon implements (§7 `pluginApi`). */
export const PLUGIN_API_LEVEL = PLUGIN_API_VERSION;
export const PLUGIN_MANIFEST_MAX_BYTES = PLUGIN_LIMITS.manifestBytes;

export type LoopbackUrl = { host: '127.0.0.1' | '::1'; port: number; path: string };

/** `http://127.0.0.1:<port>` / `http://[::1]:<port>` (+ path when `allowPath`), the wire rule. */
export function parseLoopbackUrl(raw: string, allowPath: boolean): LoopbackUrl | null {
    return parsePluginLoopbackUrl(raw, allowPath);
}

export type ManifestParseResult =
    | { ok: true; manifest: PluginManifest; warnings: string[] }
    | { ok: false; code: 'invalid_manifest' | 'unsupported_schema' | 'api_too_old' | 'payload_too_large'; message: string; issues?: string[] };

/** Validate raw manifest text (§2.1, §7 compatibility rows). */
export function parsePluginManifest(text: string, daemonApiLevel: number = PLUGIN_API_LEVEL): ManifestParseResult {
    const parsed = parsePluginManifestJson(text);
    if (!parsed.ok) {
        return { ok: false, code: parsed.error, message: parsed.message, ...(parsed.issues ? { issues: parsed.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) } : {}) };
    }
    if (parsed.manifest.minApi > daemonApiLevel) {
        return { ok: false, code: 'api_too_old', message: `plugin needs /plugin/v1 level ${parsed.manifest.minApi}; this CLI provides ${daemonApiLevel}` };
    }
    return { ok: true, manifest: parsed.manifest, warnings: parsed.unknownKeys.map((k) => `unknown field "${k}" ignored`) };
}

export const manifestHash = pluginManifestHash;
export const privilegedHash = pluginPrivilegedHash;
