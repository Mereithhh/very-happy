const REGION_FLAGS: Array<[RegExp, string]> = [
  [/\b(?:singapore|sg)\b/i, '🇸🇬'],
  [/\b(?:us(?:a)?|united states)\b/i, '🇺🇸'],
];

export function formatRelayRegion(region?: string): string {
  const normalized = region?.trim() || 'Regional relay';
  const flag = REGION_FLAGS.find(([pattern]) => pattern.test(normalized))?.[1];
  return flag ? `${flag} ${normalized}` : normalized;
}
