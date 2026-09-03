import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_RELEASES,
  changelogCliNotices,
  changelogCliTarget,
  changelogSeenValue,
  CURRENT_CHANGELOG,
  normalizeChangelogSeen,
  shouldShowChangelog,
  unseenChangelogReleases,
} from './changelogRelease';

describe('changelog releases', () => {
  it('keeps the fork history newest-first with stable unique ids', () => {
    expect(CHANGELOG_RELEASES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(CHANGELOG_RELEASES.map((release) => release.id)).size).toBe(CHANGELOG_RELEASES.length);
    expect(CHANGELOG_RELEASES.map((release) => release.date)).toEqual(
      [...CHANGELOG_RELEASES].map((release) => release.date).sort().reverse(),
    );
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
    const releases = unseenChangelogReleases(CHANGELOG_RELEASES[4].id);
    // The newest release may be web-only (no cliVersion); the CLI target is the
    // newest release that actually shipped a companion CLI, not necessarily [0].
    const newestCliVersion = CHANGELOG_RELEASES.find((r) => r.cliVersion)?.cliVersion;
    expect(changelogCliTarget(releases)?.cliVersion).toBe(newestCliVersion);
    expect(changelogCliTarget([
      { ...CURRENT_CHANGELOG, id: 'a', cliVersion: '0.2.10' },
      { ...CURRENT_CHANGELOG, id: 'b', cliVersion: undefined },
      { ...CURRENT_CHANGELOG, id: 'c', cliVersion: '0.2.30' },
    ])?.id).toBe('c');
    expect(changelogCliTarget([{ ...CURRENT_CHANGELOG, cliVersion: undefined }])).toBeNull();
  });

  it('offers the companion CLI only to active machines that actually need it', () => {
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
        targetVersion: '0.2.108',
      },
      {
        machineId: 'current',
        machineName: 'Laptop',
        currentVersion: '0.2.86',
        targetVersion: '0.2.108',
      },
      {
        machineId: 'latest',
        machineName: 'Studio',
        currentVersion: '0.2.87',
        targetVersion: '0.2.108',
      },
    ]);
  });
});
