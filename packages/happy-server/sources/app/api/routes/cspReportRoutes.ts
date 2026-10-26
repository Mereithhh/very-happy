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
 */

const KNOWN_DIRECTIVES = new Set([
    'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr',
    'font-src', 'img-src', 'media-src', 'connect-src', 'frame-src', 'worker-src', 'manifest-src', 'object-src',
    'base-uri', 'form-action', 'frame-ancestors', 'child-src',
]);

export const cspViolationsCounter = (register.getSingleMetric('csp_violations_total') as Counter<'directive' | 'disposition' | 'blocked'>) ?? new Counter({
    name: 'csp_violations_total',
    help: 'CSP violation reports received from the Web app',
    labelNames: ['directive', 'disposition', 'blocked'] as const,
    registers: [register],
});

export interface CspViolation {
    directive: string;
    disposition: 'enforce' | 'report';
    /** `inline`, `eval`, `wasm-eval`, a scheme (`data`, `blob`) or an origin. */
    blocked: string;
    /** Path of the page, without query or hash. */
    page: string;
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
                raw.push({ directive: b.effectiveDirective, disposition: b.disposition, blocked: b.blockedURL, page: b.documentURL });
            }
        }
    } else if (body && typeof body === 'object' && 'csp-report' in body) {
        const b = (body as { 'csp-report': unknown })['csp-report'] as Record<string, unknown> | null;
        if (b && typeof b === 'object') {
            raw.push({ directive: b['effective-directive'] ?? b['violated-directive'], disposition: b.disposition, blocked: b['blocked-uri'], page: b['document-uri'] });
        }
    }
    return raw.map((r) => ({
        directive: directiveOf(r.directive),
        disposition: r.disposition === 'report' ? 'report' : 'enforce',
        blocked: blockedSource(r.blocked),
        page: pagePath(r.page),
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
                cspViolationsCounter.inc({ directive: violation.directive, disposition: violation.disposition, blocked: violation.blocked.startsWith('http') || violation.blocked.startsWith('ws') ? 'origin' : violation.blocked });
                if (logged('all')) log({ module: 'csp' }, `CSP violation: ${violation.disposition} ${violation.directive} blocked ${violation.blocked} on ${violation.page || '?'}`);
            }
        }
        return reply.code(204).send();
    });
}
