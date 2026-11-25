/**
 * B-974c: the daemon ↔ server plugin channel (`plugin-op` over the machine
 * socket) and the CLI's machine-token HTTP calls to `/v1/plugins/*`.
 */
import axios from 'axios';
import { PLUGIN_SERVER_FEATURE } from '@slopus/happy-wire';
import type { ServerOpResult } from './localApi';

export type PluginServerOpResult = ServerOpResult;
export const PLUGIN_OP_TIMEOUT_MS = 10_000;
/** What a plugins-v1 server answers while plugins are off for the account (404, same as an older server). */
export const PLUGINS_DISABLED = 'plugins_disabled';

/** `plugin-op` ack: `{ ok: true, result }` | `{ ok: false, error, status?, ...details }`. */
export function parsePluginOpAnswer(answer: unknown): ServerOpResult {
    if (!answer || typeof answer !== 'object') return { kind: 'error', status: 502, error: 'invalid_server_reply' };
    const a = answer as Record<string, unknown>;
    if (a.ok === true) return { kind: 'ok', result: a.result && typeof a.result === 'object' ? a.result as Record<string, unknown> : {} };
    const error = typeof a.error === 'string' && /^[a-z_]{1,64}$/.test(a.error) ? a.error : 'server_error';
    const status = typeof a.status === 'number' && a.status >= 400 && a.status <= 599 ? a.status : 502;
    const { ok: _ok, error: _e, status: _s, ...details } = a;
    return { kind: 'error', status, error, details };
}

export type ServerInstallReply = { installId: string; state: string; reviewUrl?: string; manifestHash?: string; grants?: string[] };

export class PluginServerError extends Error {
    constructor(readonly code: string, message: string, readonly status?: number) { super(message); }
}

/** Machine-token HTTP to the server; 404 on the plugin routes = `server_too_old` (§7). */
export class PluginServerClient {
    /** `machineId`: the server needs it on every machine-token call (`X-VH-Machine-Id`, and in the body of POST /installs). */
    constructor(private readonly serverUrl: string, private readonly token: string, private readonly clientVersion: string, private readonly machineId: string) {}

    private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
        let res;
        try {
            res = await axios.request({
                method,
                url: `${this.serverUrl}${path}`,
                data: body,
                headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Happy-Client': `cli/${this.clientVersion}`, 'X-VH-Machine-Id': this.machineId },
                timeout: 15_000,
                validateStatus: () => true,
            });
        } catch (error) {
            throw new PluginServerError('server_unreachable', `cannot reach ${this.serverUrl}: ${(error as Error).message}`);
        }
        const data = res.data && typeof res.data === 'object' ? res.data as Record<string, unknown> : {};
        const tooOld = serverTooOldFrom404(res.status, res.data);
        if (tooOld) throw new PluginServerError('server_too_old', tooOld, 404);
        if (res.status >= 400) {
            const code = typeof data.error === 'string' ? data.error : `http_${res.status}`;
            throw new PluginServerError(code, typeof data.message === 'string' ? data.message : `server refused (${code})`, res.status);
        }
        return data as T;
    }

    submitManifest(manifest: unknown): Promise<ServerInstallReply> {
        return this.call('POST', '/v1/plugins/installs', { manifest, machineId: this.machineId });
    }

    disable(installId: string, reason?: string): Promise<unknown> {
        return this.call('POST', `/v1/plugins/installs/${encodeURIComponent(installId)}/disable`, reason ? { reason } : {});
    }

    /**
     * B-974h: lift a machine-set disable. The server lifts only `disabledBy === 'machine'` on this machine's
     * install; anything else answers `403 enable_requires_owner` (turn it back on in the web app).
     */
    enable(installId: string): Promise<unknown> {
        return this.call('POST', `/v1/plugins/installs/${encodeURIComponent(installId)}/enable`, { machineId: this.machineId });
    }

    /** `GET /v1/plugins/installs` (any token of the account): each install's per-install origin, keyed by installId. */
    async origins(): Promise<Map<string, string>> {
        const data = await this.call<{ installs?: unknown }>('GET', '/v1/plugins/installs');
        return originHostsFromInstalls(data);
    }

    remove(installId: string, keepItems: boolean): Promise<unknown> {
        return this.call('DELETE', `/v1/plugins/installs/${encodeURIComponent(installId)}${keepItems ? '?keepItems=1' : ''}`);
    }
}

/**
 * §7 / docs compatibility table: a 404 from `/v1/plugins/*` means "no plugin support here" unless it carries one of
 * the plugin API's own snake_case codes (`not_found` for an unknown install, …). An older server answers its generic
 * `{ error: 'Not found', path, method }` (or a plain-text / HTML page); a plugins-v1 server with the switch off answers
 * `plugins_disabled`. Returns the message for `server_too_old`, or null when the 404 is an ordinary refusal.
 */
export function serverTooOldFrom404(status: number, body: unknown): string | null {
    if (status !== 404) return null;
    const error = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    if (error === PLUGINS_DISABLED) return 'plugins are switched off on this server for this account';
    if (typeof error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error)) return null;
    return 'this server does not support plugins yet (no /v1/plugins); update the server first';
}

/** `{ installs: [{ id, origin }] }` → installId → origin host (`<label>.<pluginHost>`); entries without an https origin are skipped. */
export function originHostsFromInstalls(data: unknown): Map<string, string> {
    const out = new Map<string, string>();
    const installs = data && typeof data === 'object' ? (data as { installs?: unknown }).installs : undefined;
    if (!Array.isArray(installs)) return out;
    for (const item of installs) {
        if (!item || typeof item !== 'object') continue;
        const { id, origin } = item as { id?: unknown; origin?: unknown };
        if (typeof id !== 'string' || typeof origin !== 'string') continue;
        let url: URL;
        try { url = new URL(origin); } catch { continue; }
        if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) continue;
        out.set(id, url.host.toLowerCase());
    }
    return out;
}

/**
 * r2/r6 capability gate: `/v1/features` answers `{ features: string[] }`;
 * only `plugins-v1` in that array means yes. 404, any other shape or a
 * missing entry → `no`; a network failure or 5xx → `unknown` (treated as offline).
 */
export function pluginSupportFromFeatures(status: number, data: unknown): 'yes' | 'no' | 'unknown' {
    if (status === 404) return 'no';
    if (status < 200 || status >= 300) return 'unknown';
    const features = data && typeof data === 'object' ? (data as { features?: unknown }).features : undefined;
    return Array.isArray(features) && features.includes(PLUGIN_SERVER_FEATURE) ? 'yes' : 'no';
}

export async function fetchServerPluginSupport(serverUrl: string, token: string, clientVersion: string): Promise<'yes' | 'no' | 'unknown'> {
    try {
        const res = await axios.get(`${serverUrl}/v1/features`, {
            headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': `cli-daemon/${clientVersion}` },
            timeout: 10_000,
            validateStatus: () => true,
        });
        return pluginSupportFromFeatures(res.status, res.data);
    } catch {
        return 'unknown';
    }
}
