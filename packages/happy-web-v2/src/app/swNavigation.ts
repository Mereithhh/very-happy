/** Documents must reach the server instead of the precached SPA shell. */
export function navigationFallbackDenylist(base = '/'): RegExp[] {
  const skillsPath = `${base.replace(/\/$/, '')}/skills/`;
  const escaped = skillsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // B-701: a share-link page must come from the network (noindex / no-referrer
  // headers + meta), never from the precached app shell.
  const sharePath = `${base.replace(/\/$/, '')}/s/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // B-825: the HTML preview frame has its own CSP — never the app shell's.
  const previewPath = `${base.replace(/\/$/, '')}/html-preview.html`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [/^\/v1\//, /^\/health/, new RegExp(`^${escaped}`), new RegExp(`^${sharePath}`), new RegExp(`^${previewPath}`)];
}
