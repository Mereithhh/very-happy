/**
 * B-639: which Markdown link hrefs point at a file on the agent's machine.
 *
 * Agents write file links as `[a.jsonnet](a.jsonnet)`, `[x](/Users/me/x.ts#L12)`
 * or `[x](file:///…)`. In the browser those are same-origin URLs: the server's
 * SPA fallback answers every path with index.html, the router has no matching
 * route, and the tab lands on the route error page. A file path is never a
 * page on this site, so these open the file preview instead.
 *
 * Runs on the href AFTER `safeUrlTransform`, so anything with an unknown
 * scheme is already ''.
 */
export function localPathFromHref(href: string | undefined): string | null {
    if (!href) return null;
    const raw = href.trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('?') || raw.startsWith('//')) return null;
    let path: string;
    if (/^file:/i.test(raw)) {
        try {
            path = decodeURIComponent(new URL(raw).pathname);
        } catch {
            return null;
        }
        // file:///C:/x has pathname /C:/x
        if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } else if (/^[a-z]:[\\/]/i.test(raw)) {
        path = raw;
    } else if (hasScheme(raw)) {
        return null;                      // http:, mailto:, … — a real link
    } else {
        path = raw.replace(/[?#].*$/, '');
        try { path = decodeURIComponent(path); } catch { /* keep as written */ }
    }
    // `a.ts:42` / `a.ts:42:7` — an editor position, not part of the name.
    path = path.replace(/:\d+(?::\d+)?$/, '');
    return path.trim() || null;
}

/** Same rule as `safeUrlTransform`: a scheme's colon comes before any / ? #. */
function hasScheme(url: string): boolean {
    const colon = url.indexOf(':');
    if (colon === -1) return false;
    const delimiter = url.search(/[/?#]/);
    return delimiter === -1 || colon < delimiter;
}
