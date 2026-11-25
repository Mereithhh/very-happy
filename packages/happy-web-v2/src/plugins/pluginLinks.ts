/** B-974d: which plugin-supplied links may render, and the host they show. */
export function pluginLinkTarget(href: string | null | undefined): { url: string; host: string } | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      if (u.username || u.password) return null;
      return { url: u.href, host: u.host };
    }
    if (u.protocol === 'mailto:') return { url: u.href, host: u.pathname };
    return null;
  } catch {
    return null;
  }
}
