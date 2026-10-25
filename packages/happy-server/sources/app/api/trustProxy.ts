export type TrustedProxyConfig = false | string[];

const TRUST_PROXY_FORMAT = 'TRUST_PROXY must be a comma-separated trusted proxy IP/CIDR list (or loopback/linklocal/uniquelocal)';

/**
 * Parses an explicit proxy IP/CIDR allowlist. Deliberately rejects booleans so
 * production cannot accidentally trust arbitrary X-Forwarded-For, and hop
 * counts: they cannot validate the immediate peer, and Fastify >= 5.12 treats
 * a numeric trustProxy as "trust nobody", which would silently collapse every
 * client onto the proxy's IP (shared rate-limit bucket). Fail at startup instead.
 */
export function resolveTrustProxy(value: string | undefined): TrustedProxyConfig {
    const trimmed = value?.trim();
    if (!trimmed) return false;
    if (/^\d+$/.test(trimmed)) {
        throw new Error(`${TRUST_PROXY_FORMAT}; hop counts like "${trimmed}" are no longer supported`);
    }
    const addresses = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    if (addresses.length === 0 || addresses.some((item) => item === 'true' || item === '*')) {
        throw new Error(TRUST_PROXY_FORMAT);
    }
    return addresses;
}
