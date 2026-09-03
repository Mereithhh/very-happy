import { describe, expect, it, vi } from 'vitest';
import { CliVersionPolicyProvider, resolveCliVersionPolicyConfig } from './cliVersionPolicy';

describe('resolveCliVersionPolicyConfig', () => {
    it('keeps registry discovery opt-in by default', () => {
        expect(resolveCliVersionPolicyConfig({})).toEqual({
            recommendedVersion: null,
            minimumVersion: null,
            // B-350: no version is approved for unattended install by default.
            autoUpdateVersion: null,
            registryLookup: false,
        });
    });

    it('accepts exact configured versions and an explicit registry opt-in', () => {
        expect(resolveCliVersionPolicyConfig({
            CLI_RECOMMENDED_VERSION: ' 0.2.68 ',
            CLI_MINIMUM_VERSION: '0.2.34',
            CLI_VERSION_REGISTRY_LOOKUP: 'true',
        })).toEqual({
            recommendedVersion: '0.2.68',
            minimumVersion: '0.2.34',
            autoUpdateVersion: null,
            registryLookup: true,
        });
    });

    it('pins the auto-install version separately from the recommendation', () => {
        // The two answer different questions: recommending a release costs
        // nothing if it turns out bad, installing it unattended does.
        const config = resolveCliVersionPolicyConfig({
            CLI_VERSION_REGISTRY_LOOKUP: 'true',
            CLI_AUTO_UPDATE_VERSION: ' 0.2.117 ',
        });
        expect(config.autoUpdateVersion).toBe('0.2.117');
        expect(config.recommendedVersion).toBeNull();
    });

    it('rejects invalid or inverted configured policies', () => {
        expect(() => resolveCliVersionPolicyConfig({ CLI_RECOMMENDED_VERSION: 'latest' })).toThrow(/exact semantic/);
        expect(() => resolveCliVersionPolicyConfig({ CLI_VERSION_REGISTRY_LOOKUP: 'yes' })).toThrow(/true or false/);
        expect(() => resolveCliVersionPolicyConfig({
            CLI_RECOMMENDED_VERSION: '0.2.20',
            CLI_MINIMUM_VERSION: '0.2.21',
        })).toThrow(/must not be newer/);
    });
});

describe('CliVersionPolicyProvider', () => {
    it('returns a configured policy without contacting the registry', async () => {
        const fetcher = vi.fn();
        const provider = new CliVersionPolicyProvider({
            recommendedVersion: '0.2.68', minimumVersion: '0.2.34', autoUpdateVersion: null, registryLookup: true,
        }, fetcher, () => 123);
        await expect(provider.get()).resolves.toEqual({
            recommendedVersion: '0.2.68', minimumVersion: '0.2.34', autoUpdateVersion: null, checkedAt: 123, source: 'configured',
        });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('discovers and caches a valid registry version', async () => {
        let now = 100;
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: '0.2.68' }), { status: 200 }));
        const provider = new CliVersionPolicyProvider({
            recommendedVersion: null, minimumVersion: '0.2.34', autoUpdateVersion: null, registryLookup: true,
        }, fetcher, () => now);
        await expect(provider.get()).resolves.toMatchObject({ recommendedVersion: '0.2.68', source: 'registry' });
        now += 1_000;
        await provider.get();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent registry lookups and never recommends below minimum', async () => {
        let release!: (response: Response) => void;
        const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
        const provider = new CliVersionPolicyProvider({
            recommendedVersion: null, minimumVersion: '0.3.0', autoUpdateVersion: null, registryLookup: true,
        }, fetcher, () => 100);
        const first = provider.get();
        const second = provider.get();
        release(new Response(JSON.stringify({ version: '0.2.68' }), { status: 200 }));
        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ recommendedVersion: '0.3.0' }),
            expect.objectContaining({ recommendedVersion: '0.3.0' }),
        ]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('backs off after a failed refresh while retaining the last good policy', async () => {
        let now = 0;
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.2.68' }), { status: 200 }))
            .mockRejectedValue(new Error('offline'));
        const provider = new CliVersionPolicyProvider({
            recommendedVersion: null, minimumVersion: null, autoUpdateVersion: null, registryLookup: true,
        }, fetcher, () => now);
        await provider.get();
        now = 60 * 60 * 1000 + 1;
        await expect(provider.get()).resolves.toMatchObject({ recommendedVersion: '0.2.68' });
        await expect(provider.get()).resolves.toMatchObject({ recommendedVersion: '0.2.68' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('fails open when the registry lookup times out', async () => {
        vi.useFakeTimers();
        try {
            const fetcher = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }));
            const provider = new CliVersionPolicyProvider({
                recommendedVersion: null, minimumVersion: null, autoUpdateVersion: null, registryLookup: true,
            }, fetcher, () => 7);
            const result = provider.get();
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(result).resolves.toMatchObject({ source: 'unavailable', recommendedVersion: null });
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails open when lookup is disabled or unavailable', async () => {
        const disabled = new CliVersionPolicyProvider({
            recommendedVersion: null, minimumVersion: null, autoUpdateVersion: null, registryLookup: false,
        }, vi.fn(), () => 5);
        await expect(disabled.get()).resolves.toEqual({
            recommendedVersion: null, minimumVersion: null, autoUpdateVersion: null, checkedAt: 5, source: 'unavailable',
        });

        const failed = new CliVersionPolicyProvider({
            recommendedVersion: null, minimumVersion: '0.2.34', autoUpdateVersion: null, registryLookup: true,
        }, vi.fn(async () => { throw new Error('offline'); }), () => 6);
        await expect(failed.get()).resolves.toEqual({
            recommendedVersion: null, minimumVersion: '0.2.34', autoUpdateVersion: null, checkedAt: 6, source: 'unavailable',
        });
    });
});
