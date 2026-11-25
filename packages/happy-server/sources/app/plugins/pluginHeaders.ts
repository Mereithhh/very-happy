import { FRAME_COOKIE } from './pluginFrame';

/** B-974 §4.3 / §4.6 header rules for the plugin origins (pure). Header maps use lower-case names. */

export type HeaderMap = Record<string, string | string[]>;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Host-set headers a plugin can neither set nor remove. */
export function hostResponseHeaders(frameAncestors: readonly string[]): Record<string, string> {
    return {
        'content-security-policy': `frame-ancestors ${frameAncestors.length ? frameAncestors.join(' ') : "'none'"}`,
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), usb=(), payment=()',
    };
}

/** The plugin's CSP passes through minus any `frame-ancestors` (the host's separate policy decides framing). */
export function stripFrameAncestors(csp: string): string | null {
    const kept = csp.split(';').map(d => d.trim()).filter(d => d && !/^frame-ancestors(\s|$)/i.test(d));
    return kept.length ? kept.join('; ') : null;
}

/**
 * A plugin `Set-Cookie`, made host-only: `Domain=` removed (it can never reach a sibling install's
 * subdomain), and any cookie named like the host's own frame session dropped entirely.
 */
export function rewriteSetCookie(value: string): string | null {
    const parts = value.split(';');
    const name = parts[0].split('=')[0]?.trim() ?? '';
    if (!name || name.toLowerCase().startsWith(FRAME_COOKIE.toLowerCase())) return null;
    return parts.filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p)).join(';');
}

function asList(v: string | string[] | undefined): string[] {
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Response headers sent to the browser for a forwarded plugin response. */
export function rewriteResponseHeaders(upstream: HeaderMap, frameAncestors: readonly string[]): HeaderMap {
    const out: HeaderMap = {};
    for (const [rawName, value] of Object.entries(upstream)) {
        const name = rawName.toLowerCase();
        if (HOP_BY_HOP.has(name) || name === 'content-length' || name === 'x-frame-options' || name === 'service-worker-allowed') continue;
        if (name === 'cross-origin-resource-policy' || name === 'referrer-policy' || name === 'x-content-type-options' || name === 'permissions-policy' || name === 'feature-policy') continue;
        if (name === 'content-security-policy') {
            const kept = asList(value).map(stripFrameAncestors).filter((v): v is string => !!v);
            if (kept.length) out[name] = kept;
            continue;
        }
        if (name === 'set-cookie') {
            const kept = asList(value).map(rewriteSetCookie).filter((v): v is string => !!v);
            if (kept.length) out[name] = kept;
            continue;
        }
        out[name] = value;
    }
    const host = hostResponseHeaders(frameAncestors);
    for (const [name, value] of Object.entries(host)) {
        out[name] = name === 'content-security-policy' && out[name] ? [...asList(out[name]), value] : value;
    }
    return out;
}

/** Request headers forwarded to the daemon: no hop-by-hop, no `X-VH-*`, the host's frame cookie removed from `Cookie`. */
export function forwardRequestHeaders(incoming: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(incoming)) {
        if (value === undefined) continue;
        const name = rawName.toLowerCase();
        if (HOP_BY_HOP.has(name) || name === 'host' || name === 'content-length' || name.startsWith('x-vh-') || name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-real-ip') continue;
        const joined = Array.isArray(value) ? value.join(name === 'cookie' ? '; ' : ', ') : value;
        if (name === 'cookie') {
            const kept = joined.split(';').map(c => c.trim()).filter(c => c && !c.split('=')[0].trim().toLowerCase().startsWith(FRAME_COOKIE.toLowerCase()));
            if (kept.length) out.cookie = kept.join('; ');
            continue;
        }
        out[name] = joined;
    }
    return out;
}

/**
 * §4.6 server check for a state-changing request: `Origin`, when sent, must be this install's origin; without
 * it, `Sec-Fetch-Site: same-origin`. A sibling install is same-site (its cookies flow), so this is what stops it.
 */
export function originAllowed(method: string, headers: Record<string, string | string[] | undefined>, pluginOrigin: string): boolean {
    const m = method.toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
    const origin = headers.origin;
    if (typeof origin === 'string') return origin === pluginOrigin;
    if (Array.isArray(origin)) return false;
    return headers['sec-fetch-site'] === 'same-origin';
}

/** §4.3: a service worker script fetch is refused on plugin origins. */
export function isServiceWorkerRequest(headers: Record<string, string | string[] | undefined>): boolean {
    return headers['service-worker'] !== undefined;
}

/** v1 forwards neither WebSocket upgrades nor SSE (§4.5). */
export function isUnsupportedUpgrade(headers: Record<string, string | string[] | undefined>): boolean {
    if (headers.upgrade !== undefined) return true;
    const accept = headers.accept;
    return typeof accept === 'string' && accept.split(',').some(a => a.trim().toLowerCase().startsWith('text/event-stream'));
}
