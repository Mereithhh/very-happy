import { BlockList, isIP } from 'node:net';

// Verified 2026-09-09 against https://www.cloudflare.com/ips-v4/ and /ips-v6/.
// This list is only used with an explicit deployment opt-in. Fastify must first
// establish the actual ingress peer (Caddy overwrites untrusted XFF).
const networks = new BlockList();
const ranges = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
for (const range of ranges) {
    const [address, prefix] = range.split('/');
    networks.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
export function normalizedIp(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 64) return undefined;
    const address = value.trim();
    const version = isIP(address);
    if (version === 4) return address;
    if (version !== 6) return undefined;
    try {
        const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
        const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/i.exec(canonical);
        if (mapped) {
            const high = parseInt(mapped[1], 16); const low = parseInt(mapped[2], 16);
            return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
        }
        return canonical;
    } catch { return undefined; }
}
export function cloudflareClientIp(peer: unknown, header: unknown, enabled: boolean): string | undefined {
    if (!enabled) return undefined;
    const address = normalizedIp(peer);
    if (!address || !networks.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')) return undefined;
    return normalizedIp(header);
}
