/**
 * B-294: the title a spawned session starts with (HAPPY_IMPORT_TITLE):
 * control characters and runs of whitespace collapse to one space, at most
 * 200 characters. B-916b: also the title `session_spawn` / `spawn --title`
 * hand in. The daemon expands `${VAR}` in every session env value and fails
 * the spawn on an unknown one, so a literal `${` in a title is broken up
 * (`$ {`) — a title is text, never an env reference.
 */
export function sanitizeImportTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const collapsed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\$\{/g, '$ {');
  if (collapsed.length === 0) return null;
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}
