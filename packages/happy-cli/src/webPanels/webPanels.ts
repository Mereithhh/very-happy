/**
 * B-510: machine web panels — local web pages a person may need to look at
 * (noVNC, an agent-browser dashboard, Grafana, a dev server), declared ONLY in
 * this machine's `~/.happy/settings.json` (`webPanels`) and mirrored to the web
 * through `daemonState.webPanels`. Spec: specs/2026-09-machine-web-panels.md.
 *
 * The web, RPC and server have no write path (same rule as `todoProvider`):
 * the URL is opened by the viewer's browser, so whoever can write it chooses
 * what the user's browser loads. Only the machine owner can.
 *
 * Nothing is proxied: the viewer's browser connects to the URL directly.
 */

export interface WebPanel {
    id: string;
    title: string;
    url: string;
    /** false = the web only offers "open in new window" (site forbids framing). */
    embed: boolean;
}

export const WEB_PANEL_LIMIT = 8;
export const WEB_PANEL_TITLE_MAX = 40;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a declared entry was skipped — logged once by the daemon. */
export type WebPanelProblem = { index: number; id?: string; reason: string };

/**
 * `https:` anywhere, or `http:` on loopback only (meaningful when the viewer is
 * this machine). No userinfo — a password in the URL would be shipped to every
 * web client of the account.
 */
export function webPanelUrlProblem(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return 'url is required';
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return 'url is not a valid URL'; }
    if (url.username || url.password) return 'url must not contain credentials';
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
    return 'url must be https:// (http:// only for localhost)';
}

export function normalizeWebPanels(raw: unknown): { panels: WebPanel[]; problems: WebPanelProblem[] } {
    const panels: WebPanel[] = [];
    const problems: WebPanelProblem[] = [];
    if (raw === undefined || raw === null) return { panels, problems };
    if (!Array.isArray(raw)) return { panels, problems: [{ index: -1, reason: 'webPanels must be an array' }] };
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
        const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id.trim() : '';
        const skip = (reason: string): void => { problems.push({ index, ...(id ? { id } : {}), reason }); };
        if (!ID_RE.test(id)) return skip('id must match ^[a-z0-9][a-z0-9-]{0,31}$');
        if (seen.has(id)) return skip('duplicate id');
        const urlProblem = webPanelUrlProblem(e.url);
        if (urlProblem) return skip(urlProblem);
        if (panels.length >= WEB_PANEL_LIMIT) return skip(`more than ${WEB_PANEL_LIMIT} panels`);
        const title = (typeof e.title === 'string' && e.title.trim() ? e.title.trim() : id).slice(0, WEB_PANEL_TITLE_MAX);
        seen.add(id);
        panels.push({ id, title, url: new URL((e.url as string).trim()).href, embed: e.embed !== false });
        return undefined;
    });
    return { panels, problems };
}

/** Stable identity of a list: unchanged → the daemon does not write daemonState. */
export function webPanelsSignature(panels: readonly WebPanel[]): string {
    return JSON.stringify(panels.map((p) => [p.id, p.title, p.url, p.embed]));
}

/** Web deep link to one panel (push click target). */
export function webPanelPath(machineId: string, panelId: string): string {
    return `/machine/${encodeURIComponent(machineId)}/panel/${encodeURIComponent(panelId)}`;
}
