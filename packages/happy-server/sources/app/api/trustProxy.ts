export type TrustedProxyConfig = false | number | string[];

/**
 * Parses an explicit proxy hop count or IP/CIDR allowlist. Deliberately rejects
 * booleans so production cannot accidentally trust arbitrary X-Forwarded-For.
 */
export function resolveTrustProxy(value: string | undefined): TrustedProxyConfig {
    const trimmed = value?.trim();
    if (!trimmed) return false;
    if (/^[1-9]\d*$/.test(trimmed)) return Number(trimmed);
    const addresses = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    if (addresses.length === 0 || addresses.some((item) => item === 'true' || item === '*')) {
        throw new Error('TRUST_PROXY must be a positive hop count or comma-separated trusted IP/CIDR list');
    }
    return addresses;
}
