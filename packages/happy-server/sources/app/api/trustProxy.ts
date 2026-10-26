import { StartupConfigError } from '@/utils/startupConfigError';

export type TrustedProxyConfig = false | string[];

const TRUST_PROXY_FORMAT = 'TRUST_PROXY must list the reverse proxy peers to trust as comma-separated IPs/CIDRs, '
    + 'e.g. TRUST_PROXY=172.18.0.1 (Caddy via the Docker gateway), TRUST_PROXY=10.0.0.0/8,192.168.1.10, '
    + 'or the named ranges TRUST_PROXY=loopback,uniquelocal (also linklocal)';

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
        throw new StartupConfigError(`TRUST_PROXY="${trimmed}" is a hop count, which is no longer supported: Fastify >= 5.12 `
            + 'cannot validate the immediate peer from a hop count and trusts nobody, so every client would share '
            + `the proxy's IP and rate-limit bucket. ${TRUST_PROXY_FORMAT}.`);
    }
    const addresses = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    if (addresses.length === 0 || addresses.some((item) => item === 'true' || item === '*')) {
        throw new StartupConfigError(`${TRUST_PROXY_FORMAT}. Unrestricted trust (true/*) is never allowed.`);
    }
    return addresses;
}
