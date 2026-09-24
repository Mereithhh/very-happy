import { cloudflareClientIp, normalizedIp } from './cloudflareOrigin';
import { clientIpInfo } from '@/app/api/clientIp';
import { publishAudit, type AuditInput } from './producer';

type Request = {
    ip: string; ips?: string[]; method: string;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string } | null;
    routeOptions?: { url?: string };
};

/**
 * Client IP comes from clientIpInfo (edge-written X-Real-Client-IP from the
 * TRUST_PROXY peer, B-491). Without that header, fall back to the Fastify peer;
 * the legacy CF-Connecting-IP recovery still needs opt-in + a verified CF peer.
 */
export function requestAuditContext(request: Request): Partial<AuditInput> {
    const resolved = clientIpInfo(request);
    const proxied = resolved.source === 'proxy-header' ? resolved.ip : undefined;
    const peer = normalizedIp(request.ip);
    const origin = proxied ? undefined : cloudflareClientIp(peer, request.headers['cf-connecting-ip'], process.env.BUSINESS_AUDIT_TRUST_CLOUDFLARE === '1');
    const ip = proxied ?? origin ?? peer;
    const ua = request.headers['user-agent'];
    return {
        ip,
        ipSource: proxied ? 'edge-proxy' : origin ? 'cloudflare' : ip ? (request.ips && request.ips.length > 1 ? 'forwarded-peer' : 'socket-peer') : 'unavailable',
        userAgent: typeof ua === 'string' ? ua.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) : undefined,
        method: request.method.slice(0, 16),
        // route template only: query params may contain authentication material.
        route: request.routeOptions?.url?.slice(0, 160),
    };
}
export function auditLogin(request: Request, accountId: string, method: string): void {
    publishAudit({ ...requestAuditContext(request), kind: 'login.succeeded', accountId, payload: { method } });
}
const loginRoutes = new Set([
    '/v1/auth', '/v1/auth/request', '/v1/auth/account/request', '/v1/account/signup/password', '/v1/account/login', '/v1/account/login/email',
    '/v1/account/login/google', '/v1/account/login/refresh', '/v1/account/credentials',
]);
export function auditLoginFailure(request: Request, statusCode: number): void {
    if (request.method !== 'POST' || !request.routeOptions?.url || !loginRoutes.has(request.routeOptions.url) || statusCode < 400) return;
    publishAudit({ ...requestAuditContext(request), kind: 'login.failed', payload: { statusCode } });
}
