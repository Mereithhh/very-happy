import type { FastifyRequest } from 'fastify';

/** Public origin of a request (`https://host`) for absolute URLs such as og:image; null when unknown. */
export function requestOrigin(request: Pick<FastifyRequest, 'headers' | 'protocol' | 'hostname'>): string | null {
    const forwardedProto = request.headers['x-forwarded-proto'];
    const proto = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : null) || request.protocol || 'https';
    const host = request.headers.host || request.hostname;
    if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
    return `${proto}://${host}`;
}
