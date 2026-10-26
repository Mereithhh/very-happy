import type { FastifyReply, FastifyRequest } from 'fastify';
import { applyBrandToManifest, transformIndexHtml, type HtmlBrand } from './htmlConfigInjection';
import { requestOrigin } from './requestOrigin';
import { HTML_PREVIEW_CSP, HTML_PREVIEW_PATH, htmlSecurityHeaders, type CspMode } from './securityHeaders';

export interface WebDocumentOptions {
    /** `<script>` with `window.__HAPPY_CONFIG__`, or null. */
    injectScript: string | null;
    brand: HtmlBrand | null;
    /** Runtime config `serverUrl` (CSP connect-src). */
    serverUrl?: unknown;
    /** Regional relay origins (CSP connect-src). */
    relayOrigins?: readonly string[];
    cspMode: CspMode;
}

/**
 * onSend hook of the bundled Web app (static index.html and the SPA fallback
 * both pass through it): injects the runtime config and brand into HTML and
 * the manifest, then — B-825 — sets the CSP and security headers from the
 * exact HTML being sent, and `nosniff` on every response.
 */
export function webDocumentOnSend(opts: WebDocumentOptions) {
    return async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        reply.header('x-content-type-options', 'nosniff');
        const contentType = reply.getHeader('content-type');
        if (typeof contentType !== 'string') return payload;
        const isHtml = contentType.includes('text/html');
        const isManifest = opts.brand !== null && contentType.includes('application/manifest+json');
        if (!isHtml && !isManifest) return payload;
        if (isHtml && new URL(request.raw.url || '/', 'http://localhost').pathname === HTML_PREVIEW_PATH) {
            reply.header('content-security-policy', HTML_PREVIEW_CSP);
            return payload;
        }
        let html: string;
        if (typeof payload === 'string') {
            html = payload;
        } else if (Buffer.isBuffer(payload)) {
            html = payload.toString('utf8');
        } else if (payload && typeof (payload as any).pipe === 'function') {
            // stream — read it
            const chunks: Buffer[] = [];
            for await (const chunk of payload as any) {
                chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            html = Buffer.concat(chunks).toString('utf8');
        } else {
            return payload;
        }
        const origin = requestOrigin(request);
        const result = isManifest
            ? applyBrandToManifest(html, opts.brand)
            : transformIndexHtml(html, opts.injectScript, opts.brand, origin);
        if (isHtml) {
            reply.headers(htmlSecurityHeaders({ html: result, serverUrl: opts.serverUrl, requestOrigin: origin, relayOrigins: opts.relayOrigins }, opts.cspMode, (name) => reply.getHeader(name)));
        }
        reply.header('content-length', Buffer.byteLength(result));
        return result;
    };
}
