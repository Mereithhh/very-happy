/** A preview is browser navigation, never a relay request or a shell command. */
export function browserAddress(raw: string, appOrigin: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[\w.-]+:\d+(?:\/|$)/.test(input) ? input : `https://${input}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin === appOrigin) return null;
    return url.href;
  } catch { return null; }
}
