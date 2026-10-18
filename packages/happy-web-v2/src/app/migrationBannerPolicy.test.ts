import { describe, expect, it } from 'vitest';
import { MIGRATION_BANNER_SNOOZE_MS, migrationBannerHintId, migrationBannerVisible } from './migrationBannerPolicy';

describe('B-627 move banner snooze', () => {
  const now = 1_800_000_000_000;
  it('shows until dismissed, hides for the snooze window, then returns', () => {
    expect(migrationBannerVisible(undefined, now)).toBe(true);
    expect(migrationBannerVisible(now - 1000, now)).toBe(false);
    expect(migrationBannerVisible(now - MIGRATION_BANNER_SNOOZE_MS + 1, now)).toBe(false);
    expect(migrationBannerVisible(now - MIGRATION_BANNER_SNOOZE_MS, now)).toBe(true);
    expect(migrationBannerVisible(now + 60_000, now)).toBe(true);
    expect(migrationBannerVisible(Number.NaN, now)).toBe(true);
  });
  it('keys the dismissal by target so a second move shows again', () => {
    expect(migrationBannerHintId('https://vibe.apodex.site')).toBe('migration:https://vibe.apodex.site');
  });
});
