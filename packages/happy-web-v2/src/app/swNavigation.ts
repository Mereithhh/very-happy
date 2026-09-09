/** Documents must reach the server instead of the precached SPA shell. */
export function navigationFallbackDenylist(base = '/'): RegExp[] {
  const skillsPath = `${base.replace(/\/$/, '')}/skills/`;
  const escaped = skillsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [/^\/v1\//, /^\/health/, new RegExp(`^${escaped}`)];
}
