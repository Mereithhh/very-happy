import { Counter, register } from 'prom-client';
import { log } from '@/utils/log';
import { type Fastify } from '../types';
import { clientRateLimitKey } from '../clientIp';
import { CSP_REPORT_PATH } from '../securityHeaders';

/**
 * B-825: CSP violation reports (`report-uri`, legacy `application/csp-report`
 * and Reporting API `application/reports+json`). Anonymous and cheap on
 * purpose: no database, a per-IP in-memory budget, a bounded metric and a
 * log line that carries only the directive, the blocked origin and the page
 * path — never the query, the sample or the full blocked URL (tokens, ids).
 *
 * B-832: the log redacts every URL (logSafety), so each violation also carries a
 * URL-free classification (metric labels + log fields): the blocked scheme,
 * whether its host is loopback / private / public, whether the port is the
 * scheme default, and who made the request (`source`): this app's own bundle
 * (`self`), a browser extension, an inline/injected script, or something
 * else. That tells an extension or a local dev tool apart from a real gap in
 * the policy without storing where anyone connects to.
 */

const KNOWN_DIRECTIVES = new Set([
    'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr',
    'font-src', 'img-src', 'media-src', 'connect-src', 'frame-src', 'worker-src', 'manifest-src', 'object-src',
    'base-uri', 'form-action', 'frame-ancestors', 'child-src',
]);

type CspLabel = 'directive' | 'disposition' | 'blocked' | 'scheme' | 'host' | 'port' | 'source';

export const cspViolationsCounter = (register.getSingleMetric('csp_violations_total') as Counter<CspLabel>) ?? new Counter({
    name: 'csp_violations_total',
    help: 'CSP violation reports received from the Web app',
    labelNames: ['directive', 'disposition', 'blocked', 'scheme', 'host', 'port', 'source'] as const,
    registers: [register],
});

export interface CspViolation {
    directive: string;
    disposition: 'enforce' | 'report';
    /** `inline`, `eval`, `wasm-eval`, a scheme (`data`, `blob`) or an origin. */
    blocked: string;
    /** Path of the page, without query or hash. */
    page: string;
    /** Scheme of the blocked URL (`http`, `ws`, …); `none` for `inline`/`eval`. */
    scheme: string;
    /** Host class of the blocked URL; `none` when it has no network host. */
    host: 'loopback' | 'private' | 'public' | 'none';
    /** Whether the blocked URL uses its scheme's default port. */
    port: 'default' | 'custom' | 'none';
    /** Who made the request, from the report's source file. */
    source: 'self' | 'extension' | 'inline' | 'other' | 'none';
}

const KNOWN_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'data', 'blob', 'filesystem', 'about', 'javascript', 'chrome-extension', 'moz-extension', 'safari-web-extension']);
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const EXTENSION_SCHEME = /^(chrome-extension|moz-extension|safari-web-extension|safari-extension|ms-browser-extension|extension)(:|$)/i;

function ipv4Class(host: string): 'loopback' | 'private' | 'public' | null {
    const parts = host.split('.');
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
    const [a, b] = parts.map(Number);
    if (a === 127) return 'loopback';
    if (a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
}

/** loopback (localhost, 127/8, ::1), private (RFC 1918, link-local, CGNAT/Tailscale, ULA, .local, single-label) or public. */
export function hostClass(hostname: string): 'loopback' | 'private' | 'public' {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
    const v4 = ipv4Class(host);
    if (v4) return v4;
    if (host.includes(':')) {
        if (host === '::1') return 'loopback';
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
        if (mapped) return ipv4Class(mapped[1]) ?? 'public';
        if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host === '::') return 'private';
        return 'public';
    }
    if (!host.includes('.') || /\.(local|lan|internal|home\.arpa)$/.test(host)) return 'private';
    return 'public';
}

function classifyBlocked(value: unknown): Pick<CspViolation, 'scheme' | 'host' | 'port'> {
    const none = { scheme: 'none', host: 'none', port: 'none' } as const;
    if (typeof value !== 'string' || !value) return none;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        // Chrome reports an extension source as the bare scheme (`chrome-extension`).
        const bare = value.toLowerCase();
        return KNOWN_SCHEMES.has(bare) ? { ...none, scheme: bare } : none;
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (!NETWORK_SCHEMES.has(url.protocol)) return { ...none, scheme: KNOWN_SCHEMES.has(scheme) ? scheme : 'other' };
    return { scheme, host: hostClass(url.hostname), port: url.port === '' ? 'default' : 'custom' };
}

function withoutFragment(value: string): string {
    return value.replace(/#.*$/, '');
}

/**
 * `source-file` / `sourceFile` → who made the request. Chrome sends a bare
 * `chrome-extension` for extension scripts; a script in the document itself
 * (inline, eval, injected text) reports the document URL; the app's bundle is
 * another URL on the document's origin.
 */
export function sourceClass(sourceFile: unknown, documentUrl: unknown): CspViolation['source'] {
    if (typeof sourceFile !== 'string' || !sourceFile) return 'none';
    if (EXTENSION_SCHEME.test(sourceFile)) return 'extension';
    if (sourceFile === 'inline' || sourceFile === 'eval') return 'inline';
    let source: URL;
    try {
        source = new URL(sourceFile);
    } catch {
        return 'other';
    }
    if (typeof documentUrl === 'string') {
        if (withoutFragment(sourceFile) === withoutFragment(documentUrl)) return 'inline';
        try {
            if (source.origin !== 'null' && source.origin === new URL(documentUrl).origin) return 'self';
        } catch {
            // fall through
        }
    }
    return 'other';
}

function blockedSource(value: unknown): string {
    if (typeof value !== 'string' || !value) return 'unknown';
    if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink)$/.test(value)) return value;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:'
            ? url.origin
            : url.protocol.replace(/:$/, '');
    } catch {
        return 'other';
    }
}

function pagePath(value: unknown): string {
    if (typeof value !== 'string') return '';
    try {
        const path = new URL(value).pathname;
        // Ids in paths (sessions, shares) are not needed to find a policy gap.
        return path.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:id').slice(0, 120);
    } catch {
        return '';
    }
}

function directiveOf(value: unknown): string {
    const name = typeof value === 'string' ? value.trim().split(/\s+/)[0].toLowerCase() : '';
    return KNOWN_DIRECTIVES.has(name) ? name : 'other';
}

/** Both report formats → normalized violations (malformed entries are skipped). */
export function parseCspReports(body: unknown): CspViolation[] {
    const raw: Array<Record<string, unknown>> = [];
    if (Array.isArray(body)) {
        for (const entry of body.slice(0, 20)) {
            const report = (entry as { type?: unknown; body?: unknown } | null);
            if (report?.type === 'csp-violation' && report.body && typeof report.body === 'object') {
                const b = report.body as Record<string, unknown>;
                raw.push({ directive: b.effectiveDirective, disposition: b.disposition, blocked: b.blockedURL, page: b.documentURL, source: b.sourceFile });
            }
        }
    } else if (body && typeof body === 'object' && 'csp-report' in body) {
        const b = (body as { 'csp-report': unknown })['csp-report'] as Record<string, unknown> | null;
        if (b && typeof b === 'object') {
            raw.push({ directive: b['effective-directive'] ?? b['violated-directive'], disposition: b.disposition, blocked: b['blocked-uri'], page: b['document-uri'], source: b['source-file'] });
        }
    }
    return raw.map((r) => ({
        directive: directiveOf(r.directive),
        disposition: r.disposition === 'report' ? 'report' : 'enforce',
        blocked: blockedSource(r.blocked),
        page: pagePath(r.page),
        ...classifyBlocked(r.blocked),
        source: sourceClass(r.source, r.page),
    }));
}

/** Fixed-window per-key budget, bounded memory. */
export function createReportBudget(maxPerWindow: number, windowMs: number, maxKeys = 10_000) {
    let windowStart = 0;
    const counts = new Map<string, number>();
    return (key: string, now = Date.now()): boolean => {
        if (now - windowStart >= windowMs) {
            windowStart = now;
            counts.clear();
        }
        const used = counts.get(key) ?? 0;
        if (used >= maxPerWindow) return false;
        if (!counts.has(key) && counts.size >= maxKeys) return false;
        counts.set(key, used + 1);
        return true;
    };
}

export function cspReportRoutes(app: Fastify) {
    const perIp = createReportBudget(30, 60_000);
    const logged = createReportBudget(200, 60_000);
    app.addContentTypeParser(['application/csp-report', 'application/reports+json'], { parseAs: 'string', bodyLimit: 32 * 1024 }, (_request, body, done) => {
        try { done(null, JSON.parse(body as string)); } catch { done(null, null); }
    });
    app.post(CSP_REPORT_PATH, { bodyLimit: 32 * 1024 }, async (request, reply) => {
        if (perIp(clientRateLimitKey(request))) {
            for (const violation of parseCspReports(request.body)) {
                const { directive, disposition, scheme, host, port, source } = violation;
                const blocked = violation.blocked.startsWith('http') || violation.blocked.startsWith('ws') ? 'origin' : violation.blocked;
                cspViolationsCounter.inc({ directive, disposition, blocked, scheme, host, port, source });
                // No URL in the line: logSafety would redact it anyway; the class fields survive.
                if (logged('all')) log({ module: 'csp' }, `CSP violation: ${disposition} ${directive} blocked ${blocked} scheme=${scheme} host=${host} port=${port} source=${source} on ${violation.page || '?'}`);
            }
        }
        return reply.code(204).send();
    });
}
