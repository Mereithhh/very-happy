import { describe, expect, it } from 'vitest';
import { releaseEntryFileNames } from '../../build/releaseEntry';

const SHA = 'b25ac13dbd68276ea2da3b07f5d3c6b70ef4647e';
/** What Rollup makes of the pattern for the `index` entry. */
const entryFor = (version: string) => `/${releaseEntryFileNames(version).replace('[name]', 'index').replace('[hash]', 'hDk2hi1d')}`;

describe('release entry name (Release14 deploy contract)', () => {
    it('ends with -<sha>.js, as releaseWebAsset / wait_ready / verify_direct_asset require', () => {
        expect(entryFor(SHA)).toBe(`/assets/index-hDk2hi1d-${SHA}.js`);
        expect(entryFor(SHA).endsWith(`-${SHA}.js`)).toBe(true);
    });

    it('is what check-release.mjs parseLiveReleaseSha reads the live SHA from', () => {
        // Same pattern as scripts/changelog/check-release.mjs parseLiveReleaseSha.
        const match = /\/assets\/index-[A-Za-z0-9_-]+-([0-9a-f]{40})\.js/.exec(`<script src="${entryFor(SHA)}">`);
        expect(match?.[1]).toBe(SHA);
    });

    it('strips non-word characters from a non-SHA version (local builds)', () => {
        expect(releaseEntryFileNames('2.0.0')).toBe('assets/[name]-[hash]-200.js');
    });
});
