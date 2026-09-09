/** Provider-qualified model identifiers cross both argv and escaped tmux commands. */
export function sanitizeSpawnModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}(\[1m\])?$/i.test(value) ? value : null;
}
