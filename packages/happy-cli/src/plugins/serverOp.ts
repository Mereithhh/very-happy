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

    private async call<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
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
        if (res.status === 404 && (data.error === undefined || data.error === 'Not Found' || res.data === '' || typeof res.data === 'string')) {
            throw new PluginServerError('server_too_old', 'this server does not support plugins yet (no /v1/plugins); update the server first', 404);
        }
        if (res.status === 404 && data.error === PLUGINS_DISABLED) {
            throw new PluginServerError('server_too_old', 'plugins are switched off on this server for this account', 404);
        }
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

    remove(installId: string, keepItems: boolean): Promise<unknown> {
        return this.call('DELETE', `/v1/plugins/installs/${encodeURIComponent(installId)}${keepItems ? '?keepItems=1' : ''}`);
    }
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
