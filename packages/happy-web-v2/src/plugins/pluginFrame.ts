/**
 * B-974d (DESIGN B-973 §4.1): the plugin panel iframe's attributes, in one
 * place so tests pin them. `allow-same-origin` is safe here only because the
 * install origin is a separate per-install subdomain; never add
 * allow-top-navigation, allow-modals or allow-storage-access-by-user-activation.
 */
export const PLUGIN_FRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads';
export const PLUGIN_FRAME_ALLOW = '';
export const PLUGIN_FRAME_REFERRER_POLICY = 'no-referrer' as const;

/** The ticket URL must be on the install's own origin (https), at `/__vh/enter`. */
export function ticketUrlAllowed(url: string, installOrigin: string): boolean {
  try {
    const u = new URL(url);
    const o = new URL(installOrigin);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalDevHost(u.hostname))) return false;
    return u.origin === o.origin && u.pathname === '/__vh/enter';
  } catch {
    return false;
  }
}

/** Local dev only (`*.localhost`, `lvh.me`): plain http is allowed so dev stacks work without TLS. */
function isLocalDevHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === 'lvh.me' || host.endsWith('.lvh.me');
}

/**
 * DESIGN r3: a panelPath may carry `#fragment`. The fragment never reaches the
 * server, so it is put on the iframe URL; the `/__vh/enter` 302 keeps it.
 */
export function withPathFragment(ticketUrl: string, path: string | null | undefined): string {
  if (!path) return ticketUrl;
  const at = path.indexOf('#');
  if (at < 0 || ticketUrl.includes('#')) return ticketUrl;
  return ticketUrl + path.slice(at);
}
