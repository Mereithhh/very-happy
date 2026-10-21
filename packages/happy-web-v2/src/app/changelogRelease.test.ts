import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs release gate, no type declarations
import { extractReleases } from '../../../../scripts/changelog/check-release.mjs';
import {
  CHANGELOG_MAX_HIGHLIGHTS,
  CHANGELOG_MAX_TOPICS,
  CHANGELOG_RELEASES,
  changelogImageSrc,
  changelogMotionSrc,
  type ChangelogImage,
  changelogCliNotices,
  changelogCliTarget,
  changelogSeenValue,
  CURRENT_CHANGELOG,
  normalizeChangelogSeen,
  shouldShowChangelog,
  unseenChangelogReleases,
  whatsNewReleases,
} from './changelogRelease';

describe('changelog releases', () => {
  it('keeps the fork history newest-first with stable unique ids', () => {
    expect(CHANGELOG_RELEASES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(CHANGELOG_RELEASES.map((release) => release.id)).size).toBe(CHANGELOG_RELEASES.length);
    expect(CHANGELOG_RELEASES.map((release) => release.date)).toEqual(
      [...CHANGELOG_RELEASES].map((release) => release.date).sort().reverse(),
    );
  });

  /**
   * Two entries pointing at the same `changelog.releases.<key>` block is the
   * collision that nothing else catches. Unique ids do not help (the ids差异
   * still differ), and tsc is happy because both keys are valid — a duplicate
   * `titleKey` is only a duplicate at runtime, where the two releases render
   * identical text. It happened on 2026-09-03: two parallel sessions both took
   * `sep03y`, git auto-merged the release list without a conflict, and the only
   * reason it surfaced was that the TEXT file happened to conflict too.
   */
  it('gives every release its own text-key block', () => {
    const prefixes = CHANGELOG_RELEASES.map((release) => {
      const match = /^changelog\.releases\.([A-Za-z0-9]+)\./.exec(release.titleKey);
      expect(match, `unrecognised titleKey on ${release.id}: ${release.titleKey}`).not.toBeNull();
      return match![1];
    });
    const duplicates = prefixes.filter((key, i) => prefixes.indexOf(key) !== i);
    expect(duplicates, `two releases share a changelog text key: ${[...new Set(duplicates)].join(', ')}`).toEqual([]);
    // Every itemKey/summaryKey must live under its own release's block too — a
    // renumber that renamed the block but missed an item would otherwise point
    // into the neighbour's text. Only the PREFIX is checked here on purpose: a
    // misspelt leaf (`…sep03aa.dxt`) is not a valid SimpleTranslationKey, so
    // tsc owns that half (seen this session as TS2820).
    for (const [i, release] of CHANGELOG_RELEASES.entries()) {
      const highlightKeys = [...(release.highlights ?? []), ...(release.topics ?? [])].flatMap((h) => [h.titleKey, h.bodyKey, ...(h.image ? [h.image.altKey] : [])]);
      const extraKeys = [...(release.featuredTaglineKey ? [release.featuredTaglineKey] : []), ...(release.hero ? [release.hero.altKey] : [])];
      for (const key of [release.summaryKey, ...release.itemKeys, ...highlightKeys, ...extraKeys]) {
        expect(key, `${release.id} points outside its own block`).toContain(`changelog.releases.${prefixes[i]}.`);
      }
    }
  });

  it('keys the receipt to a release rather than a timestamp-salted build', () => {
    expect(shouldShowChangelog(null)).toBe(true);
    expect(shouldShowChangelog(changelogSeenValue())).toBe(false);
    expect(shouldShowChangelog(`${CURRENT_CHANGELOG.id}:202608271200`)).toBe(false);
    expect(shouldShowChangelog('2026-08-26-relay-and-reliability')).toBe(true);
  });

  it('shows every release published since the receipt, not just the newest', () => {
    const ids = (releases: { id: string }[]) => releases.map((release) => release.id);
    const [newest, second, third] = CHANGELOG_RELEASES;

    // Skipped two releases → both of them plus the current one, newest first.
    expect(ids(unseenChangelogReleases(CHANGELOG_RELEASES[3].id))).toEqual([newest.id, second.id, third.id]);
    // Up to date → nothing.
    expect(unseenChangelogReleases(newest.id)).toEqual([]);
    // Missed exactly one.
    expect(ids(unseenChangelogReleases(second.id))).toEqual([newest.id]);
    // Oldest receipt → whole history except the acknowledged one.
    expect(unseenChangelogReleases(CHANGELOG_RELEASES[CHANGELOG_RELEASES.length - 1].id)).toHaveLength(CHANGELOG_RELEASES.length - 1);
  });

  it('greets a fresh or unknown receipt with the current release only', () => {
    expect(unseenChangelogReleases(null)).toEqual([CURRENT_CHANGELOG]);
    expect(unseenChangelogReleases('')).toEqual([CURRENT_CHANGELOG]);
    expect(unseenChangelogReleases('1999-01-01-removed-release')).toEqual([CURRENT_CHANGELOG]);
  });

  it('diffs the legacy build-salted receipt against the release it named', () => {
    expect(normalizeChangelogSeen(`${CHANGELOG_RELEASES[2].id}:202608271200`)).toBe(CHANGELOG_RELEASES[2].id);
    expect(unseenChangelogReleases(`${CHANGELOG_RELEASES[2].id}:202608271200`).map((r) => r.id))
      .toEqual([CHANGELOG_RELEASES[0].id, CHANGELOG_RELEASES[1].id]);
    expect(unseenChangelogReleases(`${CURRENT_CHANGELOG.id}:202608271200`)).toEqual([]);
  });

  it('targets the newest companion CLI across the unseen releases', () => {
    // Anchor on the newest release that actually shipped a companion CLI
    // rather than a hardcoded index: adding a web-only release at the top used
    // to break this test for a reason that has nothing to do with what it
    // asserts (B-320 landed one and hit exactly that).
    const newestCliIndex = CHANGELOG_RELEASES.findIndex((r) => r.cliVersion);
    expect(newestCliIndex).toBeGreaterThanOrEqual(0);
    const releases = unseenChangelogReleases(CHANGELOG_RELEASES[newestCliIndex + 1].id);
    // The newest release may be web-only (no cliVersion); the CLI target is the
    // newest release that actually shipped a companion CLI, not necessarily [0].
    const newestCliVersion = CHANGELOG_RELEASES[newestCliIndex].cliVersion;
    expect(changelogCliTarget(releases)?.cliVersion).toBe(newestCliVersion);
    expect(changelogCliTarget([
      { ...CURRENT_CHANGELOG, id: 'a', cliVersion: '0.2.10' },
      { ...CURRENT_CHANGELOG, id: 'b', cliVersion: undefined },
      { ...CURRENT_CHANGELOG, id: 'c', cliVersion: '0.2.30' },
    ])?.id).toBe('c');
    expect(changelogCliTarget([{ ...CURRENT_CHANGELOG, cliVersion: undefined }])).toBeNull();
  });

  it('offers the companion CLI only to active machines that actually need it', () => {
    // Derived, not a literal: which machines get a notice is what this test is
    // about, and the target version itself is already pinned by the
    // changelogCliTarget test above. Hard-coding it here only meant every CLI
    // release had to come back and bump three copies.
    const target = CHANGELOG_RELEASES.find((r) => r.cliVersion)?.cliVersion
    const notices = changelogCliNotices([
      { id: 'old', active: true, metadata: { displayName: 'Desk', happyCliVersion: '0.2.80' } },
      { id: 'current', active: true, metadata: { host: 'Laptop', happyCliVersion: '0.2.86' } },
      { id: 'latest', active: true, metadata: { host: 'Studio', happyCliVersion: '0.2.87' } },
      { id: 'offline', active: false, metadata: { host: 'Server', happyCliVersion: '0.2.70' } },
      { id: 'unknown', active: true, metadata: { host: 'Unknown' } },
    ]);
    expect(notices).toEqual([
      {
        machineId: 'old',
        machineName: 'Desk',
        currentVersion: '0.2.80',
        targetVersion: target,
      },
      {
        machineId: 'current',
        machineName: 'Laptop',
        currentVersion: '0.2.86',
        targetVersion: target,
      },
      {
        machineId: 'latest',
        machineName: 'Studio',
        currentVersion: '0.2.87',
        targetVersion: target,
      },
    ]);
  });

  describe('highlights (B-677, specs/2026-10-whats-new.md)', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const withHighlights = CHANGELOG_RELEASES.filter((release) => release.highlights?.length);

    it('caps each release at the format limit with unique keys and a screenshot each', () => {
      expect(withHighlights.length).toBeGreaterThan(0);
      for (const release of withHighlights) {
        const highlights = release.highlights!;
        expect(highlights.length, release.id).toBeLessThanOrEqual(CHANGELOG_MAX_HIGHLIGHTS);
        expect(new Set(highlights.map((h) => h.key)).size, release.id).toBe(highlights.length);
        for (const h of highlights) {
          // changelogShots() leaves light empty when the file is missing.
          expect(h.image?.en.light, `${release.id}/${h.key} has no screenshot`).toBeTruthy();
          expect(h.image?.en.dark, `${release.id}/${h.key} has no dark screenshot`).toBeTruthy();
          if (h.action?.kind === 'link') expect(h.action.href).toMatch(/^\//);
          if (h.docsHref) expect(h.docsHref).toMatch(/^\/docs\//);
        }
      }
    });

    it('keeps every screenshot in the repo small enough to lazy-load (stills ≤150 KB, loops ≤600 KB, webp)', () => {
      const root = join(HERE, 'whats-new');
      const files = readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).map((f) => join(root, dir, f)));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file).toMatch(/\/[a-z0-9-]+-(en|zh)-(light|dark)(-motion)?\.webp$/);
        const limit = file.endsWith('-motion.webp') ? 600 * 1024 : 150 * 1024;
        expect(statSync(file).size, file).toBeLessThanOrEqual(limit);
      }
    });

    it('caps topics and gives each a capture; a loop always has its still', () => {
      for (const release of CHANGELOG_RELEASES) {
        const topics = release.topics ?? [];
        expect(topics.length, release.id).toBeLessThanOrEqual(CHANGELOG_MAX_TOPICS);
        expect(new Set(topics.map((t) => t.key)).size, release.id).toBe(topics.length);
        for (const t of topics) expect(t.image?.en.light, `${release.id}/${t.key} has no capture`).toBeTruthy();
        const images = [...(release.highlights ?? []), ...topics].flatMap((h) => (h.image ? [h.image] : [])).concat(release.hero ? [release.hero] : []);
        for (const image of images) {
          if (image.motion) expect(image.en.light, 'a looping capture needs a still fallback').toBeTruthy();
        }
      }
    });

    it('plays a loop only where one exists, in the viewer language and theme', () => {
      const still: ChangelogImage = { width: 960, height: 600, altKey: 'changelog.releases.oct21.projectsAlt', en: { light: 'en-l', dark: 'en-d' } };
      expect(changelogMotionSrc(still, 'en', 'dark')).toBeNull();
      const moving: ChangelogImage = { ...still, motion: { en: { light: 'm-en-l', dark: 'm-en-d' }, zh: { light: 'm-zh-l' } } };
      expect(changelogMotionSrc(moving, 'en', 'dark')).toBe('m-en-d');
      expect(changelogMotionSrc(moving, 'zh-Hans', 'dark')).toBe('m-zh-l');
    });

    it('tells the newest featured release on /whats-new, with the CLI that shipped beside it', () => {
      const pair = whatsNewReleases();
      expect(pair?.web.featured).toBe(true);
      expect(pair?.web.highlights?.length).toBeGreaterThan(0);
      if (pair?.cli) {
        expect(pair.cli.cliVersion).toBeTruthy();
        expect(pair.cli.date).toBe(pair.web.date);
      }
      const base = { date: '2026-01-02', titleKey: 'changelog.releases.oct21.title', summaryKey: 'changelog.releases.oct21.summary', itemKeys: [] } as const;
      const hl = [{ key: 'a', titleKey: 'changelog.releases.oct21.projectsTitle', bodyKey: 'changelog.releases.oct21.projectsBody' }] as const;
      expect(whatsNewReleases([{ ...base, id: 'cli', cliVersion: '9.9.9' }, { ...base, id: 'web', featured: true, highlights: hl }])).toEqual({
        web: expect.objectContaining({ id: 'web' }), cli: expect.objectContaining({ id: 'cli' }),
      });
      expect(whatsNewReleases([{ ...base, id: 'plain' }])).toBeNull();
    });

    it('picks the capture for the viewer language and resolved theme', () => {
      const image: ChangelogImage = {
        width: 960, height: 600, altKey: 'changelog.releases.oct21.projectsAlt',
        en: { light: 'en-l', dark: 'en-d' },
        zh: { light: 'zh-l' },
      };
      expect(changelogImageSrc(image, 'en', 'light')).toBe('en-l');
      expect(changelogImageSrc(image, 'en', 'dark')).toBe('en-d');
      expect(changelogImageSrc(image, 'zh-Hans', 'light')).toBe('zh-l');
      // A zh capture without a dark variant falls back to its light one, not to English.
      expect(changelogImageSrc(image, 'zh-Hans', 'dark')).toBe('zh-l');
      expect(changelogImageSrc({ ...image, zh: undefined }, 'zh-Hans', 'dark')).toBe('en-d');
      expect(changelogImageSrc(image, 'ru', 'dark')).toBe('en-d');
    });

    /**
     * The deploy/publish gate reads release ids with a line regex (`^\s*id:`).
     * A nested object with its own `id:` would surface as a phantom release and
     * corrupt the "did this release add an entry" diff — highlights use `key`.
     */
    it('parses to exactly the release list for the changelog release gate', () => {
      const source = readFileSync(join(HERE, 'changelogRelease.ts'), 'utf8');
      const parsed = extractReleases(source) as { id: string; cliVersion: string | null }[];
      expect(parsed.map((r) => r.id)).toEqual(CHANGELOG_RELEASES.map((r) => r.id));
      expect(parsed.map((r) => r.cliVersion ?? undefined)).toEqual(CHANGELOG_RELEASES.map((r) => r.cliVersion));
    });
  });
});
