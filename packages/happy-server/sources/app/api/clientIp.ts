import { BlockList, isIP } from 'node:net';
import { normalizedIp } from '@/app/audit/cloudflareOrigin';
import { resolveTrustProxy, type TrustedProxyConfig } from './trustProxy';

/**
 * Single source of the end-user IP (B-491).
 *
 * The production edge (Caddy on the host) is the only component that decides
 * who the client is: it drops any inbound `X-Real-Client-IP` and rewrites it
 * from CloudFront's `CloudFront-Viewer-Address` (verified origin secret), from
 * `CF-Connecting-IP` (peer in Cloudflare's ranges) or from the TCP peer. The
 * server trusts that header only when the socket peer is the configured
 * `TRUST_PROXY` boundary; otherwise it keeps Fastify's `request.ip`.
 */
export const CLIENT_IP_HEADER = 'x-real-client-ip';

export type ClientIpSource = 'proxy-header' | 'peer';

type ClientIpRequest = {
    ip: string;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string } | null;
};

type PeerCheck = (peer: string | undefined) => boolean;

const NAMED_RANGES: Record<string, string[]> = {
    loopback: ['127.0.0.0/8', '::1/128'],
    linklocal: ['169.254.0.0/16', 'fe80::/10'],
    uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** Mirrors Fastify's trustProxy semantics for the immediate peer only; unknown entries never match. */
export function compileTrustedPeer(config: TrustedProxyConfig): PeerCheck {
    if (config === false) return () => false;
    if (typeof config === 'number') return (peer) => config >= 1 && peer !== undefined;
    const list = new BlockList();
    for (const entry of config.flatMap((item) => NAMED_RANGES[item] ?? [item])) {
        const [address, prefix] = entry.split('/');
        const version = isIP(address);
        if (!version) continue;
        const family = version === 6 ? 'ipv6' : 'ipv4';
        const max = version === 6 ? 128 : 32;
        if (prefix === undefined) { list.addAddress(address, family); continue; }
        const bits = Number(prefix);
        if (!/^\d+$/.test(prefix) || bits > max) continue;
        list.addSubnet(address, bits, family);
    }
    return (peer) => peer !== undefined && list.check(peer, isIP(peer) === 6 ? 'ipv6' : 'ipv4');
}

let trustedPeer: PeerCheck | undefined;

/** startApi passes the same config it gives Fastify, so both agree on the boundary. */
export function configureClientIpTrust(config: TrustedProxyConfig): void {
    trustedPeer = compileTrustedPeer(config);
}

function currentTrustedPeer(): PeerCheck {
    trustedPeer ??= compileTrustedPeer(resolveTrustProxy(process.env.TRUST_PROXY));
    return trustedPeer;
}

export function clientIpInfo(request: ClientIpRequest): { ip: string; source: ClientIpSource } {
    const peer = normalizedIp(request.socket?.remoteAddress);
    if (currentTrustedPeer()(peer)) {
        const header = request.headers?.[CLIENT_IP_HEADER];
        const ip = typeof header === 'string' ? normalizedIp(header) : undefined;
        if (ip) return { ip, source: 'proxy-header' };
    }
    return { ip: request.ip, source: 'peer' };
}

/** The end-user IP for logs, audit and rate limiting. */
export function clientIp(request: ClientIpRequest): string {
    return clientIpInfo(request).ip;
}

/**
 * Rate-limit identity: the IPv4 address, or the IPv6 /64 (one subscriber
 * usually owns a whole /64, so per-address IPv6 buckets are trivially evaded).
 */
export function clientRateLimitKey(request: ClientIpRequest): string {
    return rateLimitKeyForIp(clientIp(request));
}

export function rateLimitKeyForIp(ip: string): string {
    const normalized = normalizedIp(ip);
    if (!normalized || isIP(normalized) !== 6) return normalized ?? ip;
    const groups = expandIpv6(normalized);
    return groups ? `${groups.slice(0, 4).join(':')}::/64` : normalized;
}

function expandIpv6(address: string): string[] | undefined {
    const [head, tail] = address.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    if (right.some((part) => part.includes('.')) || left.some((part) => part.includes('.'))) return undefined;
    const missing = address.includes('::') ? 8 - left.length - right.length : 0;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8) return undefined;
    return groups.map((group) => (parseInt(group, 16) || 0).toString(16));
}

/** Fastify `req` log serializer: same shape as Fastify's default, with the resolved client IP. */
export function requestLogSerializer(request: ClientIpRequest & {
    method: string; url: string; host?: string; socket?: { remoteAddress?: string; remotePort?: number } | null;
}) {
    if (!request || typeof request !== 'object') return request;
    return {
        method: request.method,
        url: request.url,
        host: request.host,
        remoteAddress: clientIp(request),
        remotePort: request.socket?.remotePort,
    };
}
