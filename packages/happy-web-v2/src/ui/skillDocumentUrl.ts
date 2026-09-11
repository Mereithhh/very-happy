/** Only bundled, same-origin Markdown documents belong in the skill reader. */
export function skillDocumentUrl(href: string | undefined, pageUrl: string, documentUrl = pageUrl, appBase = '/'): string | null {
    if (!href || href.startsWith('#')) return null;
    try {
        const page = new URL(pageUrl);
        const prefix = `${appBase.replace(/\/$/, '')}/skills/`;
        const input = prefix !== '/skills/' && href.startsWith('/skills/') ? `${prefix}${href.slice('/skills/'.length)}` : href;
        const url = new URL(input, documentUrl);
        if (url.origin !== page.origin || !/^https?:$/.test(url.protocol) || url.username || url.password) return null;
        if (!url.pathname.startsWith(prefix) || !/\.md$/i.test(url.pathname)) return null;
        return url.href;
    } catch {
        return null;
    }
}

/** Front matter is agent metadata, not a Markdown heading. Copy/download keep it. */
export function skillDocumentBody(text: string): string {
    return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}
