/**
 * B-819: the session a cold open lands on, read from the URL before the app
 * has rendered anything. Its message catch-up starts with the session list
 * (sync #init) instead of when SessionDetailScreen mounts — QA8 F2 measured
 * that mount ~900ms after the session keys were there, so neither the cache
 * nor the network page could start earlier than it.
 */
export function routedSessionId(pathname: string | undefined | null): string | null {
    const match = /^\/session\/([^/?#]+)\/?$/.exec(pathname ?? '');
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
}
