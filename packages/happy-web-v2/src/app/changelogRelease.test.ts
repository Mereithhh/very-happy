import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_RELEASES,
  changelogCliNotices,
  changelogSeenValue,
  CURRENT_CHANGELOG,
  shouldShowChangelog,
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
        targetVersion: '0.2.97',
      },
      {
        machineId: 'current',
        machineName: 'Laptop',
        currentVersion: '0.2.86',
        targetVersion: '0.2.97',
      },
      {
        machineId: 'latest',
        machineName: 'Studio',
        currentVersion: '0.2.87',
        targetVersion: '0.2.97',
      },
    ]);
  });
});
