/**
 * B-981 daemon side: keep this machine's global channel accounts in step with
 * the server (`GET /v1/model-channels`, machine token → keys included).
 *
 *   start + every 5 minutes; 404 = an older server = no channels (removes any);
 *   network failure / other errors / malformed answer = keep the last good set.
 *
 * Never logs a key or a response body; `redirect: 'error'` so the bearer token
 * never follows a redirect elsewhere.
 */
import { MODEL_CHANNELS_PATH, parseModelChannelsResponse } from '@slopus/happy-wire';
import { materializeGlobalChannels, type MaterializeResult } from './globalAccounts';

export const GLOBAL_CHANNEL_SYNC_INTERVAL_MS = 5 * 60_000;

export type GlobalChannelSyncOutcome =
    | { kind: 'applied'; result: MaterializeResult }
    | { kind: 'unsupported'; result: MaterializeResult }
    | { kind: 'kept'; reason: string };

export async function syncGlobalChannelsOnce(opts: {
    home: string;
    serverUrl: string;
    token: () => Promise<string | null> | string | null;
    fetch?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
}): Promise<GlobalChannelSyncOutcome> {
    const bearer = await opts.token();
    if (!bearer) return { kind: 'kept', reason: 'not signed in' };
    const now = opts.now ?? Date.now;
    let response: Response;
    try {
        response = await (opts.fetch ?? fetch)(`${opts.serverUrl}${MODEL_CHANNELS_PATH}`, {
            headers: { authorization: `Bearer ${bearer}` },
            redirect: 'error',
            signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
    } catch (error) {
        return { kind: 'kept', reason: `network: ${error instanceof Error ? error.name : 'error'}` };
    }
    if (response.status === 404) {
        return { kind: 'unsupported', result: materializeGlobalChannels(opts.home, { revision: 'none', channels: [] }, now()) };
    }
    if (!response.ok) return { kind: 'kept', reason: `http ${response.status}` };
    let json: unknown;
    try {
        json = await response.json();
    } catch {
        return { kind: 'kept', reason: 'not JSON' };
    }
    const parsed = parseModelChannelsResponse(json);
    if (!parsed) return { kind: 'kept', reason: 'malformed answer' };
    return { kind: 'applied', result: materializeGlobalChannels(opts.home, parsed, now()) };
}

export function startGlobalChannelSync(opts: Parameters<typeof syncGlobalChannelsOnce>[0] & {
    onChanged: (result: MaterializeResult) => void;
    log?: (message: string) => void;
    intervalMs?: number;
}): { stop: () => void; refresh: () => Promise<void> } {
    let running: Promise<void> | null = null;
    const refresh = () => running ??= (async () => {
        try {
            const outcome = await syncGlobalChannelsOnce(opts);
            if (outcome.kind === 'kept') opts.log?.(`[B-981] global channels unchanged (${outcome.reason})`);
            else if (outcome.result.changed) {
                opts.log?.(`[B-981] global channels updated (+${outcome.result.added.join(',') || '0'} -${outcome.result.removed.join(',') || '0'})`);
                opts.onChanged(outcome.result);
            }
        } catch (error) {
            opts.log?.(`[B-981] global channel sync failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            running = null;
        }
    })();
    void refresh();
    const timer = setInterval(() => { void refresh(); }, opts.intervalMs ?? GLOBAL_CHANNEL_SYNC_INTERVAL_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer), refresh };
}
