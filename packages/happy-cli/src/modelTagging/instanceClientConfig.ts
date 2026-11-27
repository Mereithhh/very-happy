/**
 * B-980: the client half of the operator's instance config
 * (`GET /v1/instance/config`). Fetched once per wrapper start with a short
 * timeout; the last good answer is cached in `$HAPPY_HOME_DIR` so a slow or
 * unreachable server at startup keeps the previous behaviour instead of
 * silently turning tagging off. An older server (404) means "nothing configured".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCE_CONFIG_PATH, InstanceClientConfigSchema, type InstanceClientConfig } from '@slopus/happy-wire';

type Fetch = typeof fetch;

export function instanceConfigCachePath(happyHome: string): string {
    return join(happyHome, 'instance-config.json');
}

function readCache(path: string): InstanceClientConfig | null {
    try {
        const parsed = InstanceClientConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeCache(path: string, value: InstanceClientConfig): void {
    try {
        mkdirSync(join(path, '..'), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
        renameSync(tmp, path);
    } catch {
        // cache is best effort
    }
}

export async function loadInstanceClientConfig(opts: {
    serverUrl: string;
    token: string;
    happyHome: string;
    fetch?: Fetch;
    timeoutMs?: number;
}): Promise<InstanceClientConfig> {
    const cachePath = instanceConfigCachePath(opts.happyHome);
    const doFetch = opts.fetch ?? fetch;
    try {
        const res = await doFetch(`${opts.serverUrl}${INSTANCE_CONFIG_PATH}`, {
            headers: { authorization: `Bearer ${opts.token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
        });
        if (res.status === 404) {
            const empty: InstanceClientConfig = {};
            writeCache(cachePath, empty);
            return empty;
        }
        if (!res.ok) return readCache(cachePath) ?? {};
        const parsed = InstanceClientConfigSchema.safeParse(await res.json());
        if (!parsed.success) return readCache(cachePath) ?? {};
        writeCache(cachePath, parsed.data);
        return parsed.data;
    } catch {
        return readCache(cachePath) ?? {};
    }
}
