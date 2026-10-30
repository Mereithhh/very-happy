import { useEffect } from 'react';
import { create } from 'zustand';
import { parseLatestModelTable, type LatestModelTable } from '@slopus/happy-wire';
import { getServerUrl } from './serverConfig';

/**
 * B-844: the server's "follow latest" table (`GET /v1/models/latest`), so a
 * new flagship reaches every client without a web release. `null` = not
 * fetched (yet) or unavailable: resolution then uses the copy bundled in
 * happy-wire. The last good answer is kept per device in localStorage so a
 * cold start resolves with it before the network answers.
 */
const CACHE_KEY = 'vh.latestModels.v1';
const REFRESH_MS = 30 * 60_000;

function readCache(): LatestModelTable | null {
    try {
        const raw = globalThis.localStorage?.getItem(CACHE_KEY);
        return raw ? parseLatestModelTable(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function writeCache(table: LatestModelTable): void {
    try {
        globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(table));
    } catch {
        // storage full / blocked: the in-memory copy still applies
    }
}

type LatestModelsState = { table: LatestModelTable | null; fetchedAt: number };

export const latestModelsStore = create<LatestModelsState>(() => ({ table: readCache(), fetchedAt: 0 }));

let inflight: Promise<void> | null = null;

export function refreshLatestModelTable(fetcher: typeof fetch = fetch, now = Date.now()): Promise<void> {
    if (inflight) return inflight;
    if (now - latestModelsStore.getState().fetchedAt < REFRESH_MS) return Promise.resolve();
    latestModelsStore.setState({ fetchedAt: now });
    inflight = (async () => {
        try {
            const response = await fetcher(`${getServerUrl()}/v1/models/latest`, { headers: { accept: 'application/json' } });
            if (!response.ok) return;
            const table = parseLatestModelTable((await response.json() as { table?: unknown })?.table);
            if (!table) return;
            latestModelsStore.setState({ table });
            writeCache(table);
        } catch {
            // offline / old server: keep the cached or bundled table
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** Non-reactive read for pure send-time resolution (message meta). */
export function getLatestModelTable(): LatestModelTable | null {
    return latestModelsStore.getState().table;
}

/** Reactive read for pickers and settings; kicks a (throttled) refresh. */
export function useLatestModelTable(): LatestModelTable | null {
    const table = latestModelsStore((state) => state.table);
    useEffect(() => { void refreshLatestModelTable(); }, []);
    return table;
}
