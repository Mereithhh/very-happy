import { describe, expect, it } from 'vitest';
import { resolveReleaseConfig } from './releaseConfig';

describe('resolveReleaseConfig', () => {
    it('keeps standalone and legacy servers disabled by default', () => {
        expect(resolveReleaseConfig({})).toBeNull();
    });

    it('requires the release identity as one atomic configuration', () => {
        expect(() => resolveReleaseConfig({ VH_RELEASE_SLOT: 'blue' })).toThrow(/configured together/);
    });

    it('accepts a complete immutable release identity', () => {
        expect(resolveReleaseConfig({
            VH_RELEASE_SLOT: 'green',
            VH_RELEASE_SHA: 'a'.repeat(40),
            VH_RELEASE_ADMIN_TOKEN: 't'.repeat(32),
            VH_RELEASE_ADAPTER_WARMUP_MS: '4000',
        })).toEqual({
            slot: 'green',
            release: 'a'.repeat(40),
            adminToken: 't'.repeat(32),
            adapterWarmupMs: 4000,
        });
    });

    it('rejects ambiguous slots and mutable release labels', () => {
        const base = { VH_RELEASE_ADMIN_TOKEN: 't'.repeat(32), VH_RELEASE_SHA: 'a'.repeat(40) };
        expect(() => resolveReleaseConfig({ ...base, VH_RELEASE_SLOT: 'candidate' })).toThrow(/blue or green/);
        expect(() => resolveReleaseConfig({ ...base, VH_RELEASE_SLOT: 'blue', VH_RELEASE_SHA: 'latest' })).toThrow(/40-character/);
    });
});
