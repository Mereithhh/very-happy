/** B-627: a dismissed move banner comes back after a while — the old relay is going away. */
export const MIGRATION_BANNER_SNOOZE_MS = 3 * 24 * 60 * 60_000;

export function migrationBannerHintId(targetUrl: string): string {
  return `migration:${targetUrl}`;
}

export function migrationBannerVisible(dismissedAtMs: number | undefined, nowMs: number): boolean {
  if (typeof dismissedAtMs !== 'number' || !Number.isFinite(dismissedAtMs)) return true;
  // A clock that jumped backwards must not hide the banner for days.
  if (dismissedAtMs > nowMs) return true;
  return nowMs - dismissedAtMs >= MIGRATION_BANNER_SNOOZE_MS;
}
