import { createHash } from 'node:crypto';

/**
 * B-825: Content-Security-Policy and the other browser security headers of the
 * bundled Web app (HTML documents served by api.ts / spaFallback.ts).
 *
 * Inline scripts are allowed by hash, never by 'unsafe-inline': the hashes are
 * taken from the exact HTML being sent — after the runtime config and brand
 * were injected — so the startup theme script (web-v2 build/startupSplash.ts)
 * and `window.__HAPPY_CONFIG__` run, and nothing else inline does.
 *
 * Rollout (CSP_MODE, PR #B-825):
 *  - The enforced policy blocks what CSP is for — script injection (scripts
 *    only from this origin, the hashed inline ones and Google sign-in; no
 *    plugins, no <base> hijack, no framing by other sites) — and keeps the
 *    resource directives as wide as the product needs today: the user picks
 *    servers, relays, machine panels, sound packs and Markdown images at run
 *    time, so connect/img/frame/media stay open to any https origin.
 *  - A Report-Only policy narrows connect-src to the origins the app itself
 *    knows. Its reports (/v1/csp-report) show which other origins real users
 *    reach before that is enforced.
 *  `CSP_MODE=report-only` sends the enforced policy as Report-Only too (no
 *  blocking at all); `off` sends none. Default: enforce.
 */

export type CspMode = 'enforce' | 'report-only' | 'off';

export const CSP_REPORT_PATH = '/v1/csp-report';

/** Self-hosted CJK terminal font (web-v2 terminalCjkFont.ts). */
const FONT_CDN = 'https://veryhappy-fonts.pages.dev';
/** Google Identity Services button (web-v2 GoogleLoginButton.tsx), only loaded when configured. */
const GOOGLE_GSI = 'https://accounts.google.com';
/** Voice (web-v2 assistant/asrStream.ts, ttsStream.ts). */
const ELEVENLABS = ['https://api.elevenlabs.io', 'wss://api.elevenlabs.io'];

export function parseCspMode(value: string | undefined): CspMode {
    const mode = value?.trim().toLowerCase();
    return mode === 'report-only' || mode === 'off' ? mode : 'enforce';
}

/** `<script>` elements without `src` — their text is what the browser hashes. */
export function inlineScriptHashes(html: string): string[] {
    const hashes = new Set<string>();
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (/\ssrc\s*=/i.test(` ${match[1]}`)) continue;
        hashes.add(`'sha256-${createHash('sha256').update(match[2], 'utf8').digest('base64')}'`);
    }
    return [...hashes].sort();
}

/** `https://a.b:1/x` → `https://a.b:1`; anything else (same-origin, garbage) → null. */
function originOf(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
    } catch {
        return null;
    }
}

function socketOrigin(origin: string): string {
    return origin.replace(/^http/, 'ws');
}

export interface CspContext {
    /** The final HTML (hashes come from it). */
    html: string;
    /** Runtime config `serverUrl` — "same-origin" or an absolute API origin. */
    serverUrl?: unknown;
    /** Public origin of this request (`https://veryhappy.dev`), when known. */
    requestOrigin?: string | null;
}

function directives(entries: Array<[string, string[]]>): string {
    return entries.map(([name, values]) => [name, ...values].join(' ')).join('; ');
}

/** The enforced policy (see the module comment for what it does and does not restrict). */
export function contentSecurityPolicy(ctx: CspContext): string {
    const server = originOf(ctx.serverUrl);
    // An http API (local self-host) needs its own scheme; https/wss are open anyway.
    const plainServer = server?.startsWith('http:') ? [server, socketOrigin(server)] : [];
    return directives([
        ['default-src', ["'self'"]],
        ['script-src', ["'self'", ...inlineScriptHashes(ctx.html), "'wasm-unsafe-eval'", `${GOOGLE_GSI}/gsi/client`]],
        ['style-src', ["'self'", "'unsafe-inline'", FONT_CDN, `${GOOGLE_GSI}/gsi/style`]],
        ['font-src', ["'self'", 'data:', FONT_CDN]],
        ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
        ['media-src', ["'self'", 'data:', 'blob:', 'https:']],
        ['connect-src', ["'self'", 'https:', 'wss:', 'blob:', 'data:', ...plainServer]],
        // Machine panels and the browser preview frame user URLs, some on http://localhost.
        ['frame-src', ["'self'", 'https:', 'http:', 'blob:']],
        ['worker-src', ["'self'", 'blob:']],
        ['manifest-src', ["'self'"]],
        // The PDF preview (an iframe on a blob: URL, which inherits this policy) still
        // renders: Chromium's viewer is not an <object>/<embed> load of the page's own.
        ['object-src', ["'none'"]],
        ['base-uri', ["'self'"]],
        ['form-action', ["'self'"]],
        ['frame-ancestors', ["'self'"]],
        ['report-uri', [CSP_REPORT_PATH]],
    ]);
}

/** Stage two, observed only: connect-src limited to the origins the app itself names. */
export function reportOnlyContentSecurityPolicy(ctx: CspContext): string {
    const server = originOf(ctx.serverUrl);
    const self = ctx.requestOrigin ? originOf(ctx.requestOrigin) : null;
    const known = [server, self].filter((origin): origin is string => origin !== null);
    const connect = ["'self'", ...new Set(known.flatMap((origin) => [origin, socketOrigin(origin)])), GOOGLE_GSI, ...ELEVENLABS, 'blob:', 'data:'];
    return contentSecurityPolicy(ctx)
        .replace(/connect-src [^;]*/, `connect-src ${connect.join(' ')}`)
        // Ignored (with a console warning) in a Report-Only policy; enforced above.
        .replace(/; frame-ancestors [^;]*/, '');
}

/**
 * The HTML file preview frame (web-v2 public/html-preview.html). A `srcdoc`
 * frame inherits the app's policy, so an agent-written page's inline scripts
 * and CDN assets would be blocked; this document gets its own policy instead.
 * `sandbox` (without allow-same-origin) makes it an opaque origin even when
 * opened directly, so whatever it renders can never reach this origin's
 * storage or DOM; only this app may frame it.
 */
export const HTML_PREVIEW_PATH = '/html-preview.html';
export const HTML_PREVIEW_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'";

/**
 * Header map for an HTML document. `existing` holds headers a route already
 * chose (a share page keeps its `Referrer-Policy: no-referrer`).
 */
export function htmlSecurityHeaders(ctx: CspContext, mode: CspMode, existing: (name: string) => unknown = () => undefined): Record<string, string> {
    const headers: Record<string, string> = {
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        // Microphone: voice input. Everything else this app never asks for.
        'permissions-policy': 'camera=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), microphone=(self)',
    };
    if (!existing('referrer-policy')) headers['referrer-policy'] = 'strict-origin-when-cross-origin';
    if (mode === 'enforce') {
        headers['content-security-policy'] = contentSecurityPolicy(ctx);
        headers['content-security-policy-report-only'] = reportOnlyContentSecurityPolicy(ctx);
    } else if (mode === 'report-only') {
        headers['content-security-policy-report-only'] = contentSecurityPolicy(ctx);
    }
    return headers;
}
