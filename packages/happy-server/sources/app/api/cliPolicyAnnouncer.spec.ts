import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCliPolicyAnnouncer, versionToAnnounce } from './cliPolicyAnnouncer';
import { followsPromotedLatest, resolveCliVersionPolicyConfig } from './cliVersionPolicy';

describe('versionToAnnounce (B-718)', () => {
    it('treats the first answer as a baseline and announces only a changed, non-null target', () => {
        expect(versionToAnnounce(undefined, '0.2.180')).toBeNull();
        expect(versionToAnnounce('0.2.179', '0.2.180')).toBe('0.2.180');
        expect(versionToAnnounce('0.2.180', '0.2.180')).toBeNull();
        expect(versionToAnnounce('0.2.180', null)).toBeNull();
        expect(versionToAnnounce(null, '0.2.180')).toBe('0.2.180');
    });
});

describe('startCliPolicyAnnouncer (B-718)', () => {
    let stop: (() => void) | null = null;
    afterEach(() => { stop?.(); stop = null; });

    it('emits once when npm latest is promoted, never for an unavailable registry', async () => {
        const answers = [
            { autoUpdateVersion: '0.2.179', source: 'registry' },
            { autoUpdateVersion: '0.2.179', source: 'registry' },
            { autoUpdateVersion: '0.2.179', source: 'unavailable' },
            { autoUpdateVersion: '0.2.180', source: 'registry' },
            { autoUpdateVersion: '0.2.180', source: 'registry' },
        ];
        const emit = vi.fn();
        const announcer = startCliPolicyAnnouncer({ current: async () => answers.shift()!, emit, intervalMs: 3_600_000 });
        stop = announcer.stop;
        await vi.waitFor(() => expect(answers).toHaveLength(4)); // startup baseline
        const results = [await announcer.check(), await announcer.check(), await announcer.check(), await announcer.check()];
        expect(results).toEqual([null, null, '0.2.180', null]);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith({ autoUpdateVersion: '0.2.180' });
    });

    it('survives a failing lookup', async () => {
        const emit = vi.fn();
        const announcer = startCliPolicyAnnouncer({ current: async () => { throw new Error('boom'); }, emit, intervalMs: 3_600_000 });
        stop = announcer.stop;
        expect(await announcer.check()).toBeNull();
        expect(emit).not.toHaveBeenCalled();
    });
});

describe('followsPromotedLatest (B-718)', () => {
    it('is on only for CLI_AUTO_UPDATE_VERSION=latest with registry lookup and no recommendation hold', () => {
        expect(followsPromotedLatest(resolveCliVersionPolicyConfig({ CLI_AUTO_UPDATE_VERSION: 'latest', CLI_VERSION_REGISTRY_LOOKUP: 'true' }))).toBe(true);
        expect(followsPromotedLatest(resolveCliVersionPolicyConfig({ CLI_AUTO_UPDATE_VERSION: 'latest', CLI_VERSION_REGISTRY_LOOKUP: 'true', CLI_RECOMMENDED_VERSION: '0.2.170' }))).toBe(false);
        expect(followsPromotedLatest(resolveCliVersionPolicyConfig({ CLI_AUTO_UPDATE_VERSION: '0.2.170', CLI_VERSION_REGISTRY_LOOKUP: 'true' }))).toBe(false);
        expect(followsPromotedLatest(resolveCliVersionPolicyConfig({ CLI_VERSION_REGISTRY_LOOKUP: 'true' }))).toBe(false);
    });
});

describe('CLI_VERSION_REGISTRY_URL (B-718)', () => {
    it('defaults to npm and accepts only http(s)', () => {
        expect(resolveCliVersionPolicyConfig({}).registryUrl).toBe('https://registry.npmjs.org/very-happy-cli/latest');
        expect(resolveCliVersionPolicyConfig({ CLI_VERSION_REGISTRY_URL: 'http://127.0.0.1:5337/very-happy-cli/latest' }).registryUrl).toBe('http://127.0.0.1:5337/very-happy-cli/latest');
        expect(() => resolveCliVersionPolicyConfig({ CLI_VERSION_REGISTRY_URL: 'file:///etc/passwd' })).toThrow();
        expect(() => resolveCliVersionPolicyConfig({ CLI_VERSION_REGISTRY_URL: 'not a url' })).toThrow();
    });
});
