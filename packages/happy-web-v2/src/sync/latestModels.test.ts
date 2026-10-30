// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_LATEST_MODELS } from '@slopus/happy-wire';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.test' }));

// B-844: the server's latest-models table, cached per device.
describe('latestModels store', () => {
    beforeEach(() => {
        vi.resetModules();
        localStorage.clear();
    });

    const opus6 = { ...BUNDLED_LATEST_MODELS, version: 2 };

    it('fetches the server table, keeps it in memory and in localStorage', async () => {
        const mod = await import('./latestModels');
        expect(mod.getLatestModelTable()).toBeNull();
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ table: opus6, source: 'configured' })));
        await mod.refreshLatestModelTable(fetcher as unknown as typeof fetch, 10_000_000_000);
        expect(fetcher).toHaveBeenCalledWith('https://relay.test/v1/models/latest', expect.anything());
        expect(mod.getLatestModelTable()?.version).toBe(2);
        // Throttled: a second call within 30 min does not refetch.
        await mod.refreshLatestModelTable(fetcher as unknown as typeof fetch, 10_000_000_000 + 60_000);
        expect(fetcher).toHaveBeenCalledTimes(1);

        vi.resetModules();
        const reloaded = await import('./latestModels');
        expect(reloaded.getLatestModelTable()?.version).toBe(2);
    });

    it('an old server (404) or a bad body keeps the previous table', async () => {
        const mod = await import('./latestModels');
        await mod.refreshLatestModelTable((async () => new Response('', { status: 404 })) as unknown as typeof fetch, 10_000_000_000);
        expect(mod.getLatestModelTable()).toBeNull();
        await mod.refreshLatestModelTable((async () => new Response(JSON.stringify({ table: { version: 3 } }))) as unknown as typeof fetch, 10_000_000_000 + 31 * 60_000);
        expect(mod.getLatestModelTable()).toBeNull();
    });
});
