import { createHash, timingSafeEqual } from 'node:crypto';
import { allowAuthRequest } from './authRateLimiter';

const CLAIM_SECRET_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const DEFAULT_MAX_PENDING_AUTH_PAIRINGS = 1_000;

function positiveInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function decodeFixedBase64(value: string, bytes: number): Buffer | null {
    if (value.length > Math.ceil(bytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
    try {
        const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        return decoded.length === bytes ? decoded : null;
    } catch {
        return null;
    }
}

export function decodePairingPublicKey(value: string): Buffer | null {
    return decodeFixedBase64(value, PUBLIC_KEY_BYTES);
}

export function hashPairingValue(value: Uint8Array | string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function claimSecretHash(value: string | undefined): string | null {
    const secret = value ? decodeFixedBase64(value, CLAIM_SECRET_BYTES) : null;
    return secret ? hashPairingValue(secret) : null;
}

export function claimSecretMatches(value: string, expectedHash: string): boolean {
    const actual = claimSecretHash(value);
    if (!actual || expectedHash.length !== 64) return false;
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function pairingExpiresAt(createdAt: Date): Date {
    const ttlMinutes = positiveInt('AUTH_PAIRING_TTL_MINUTES', 10, 1, 60);
    return new Date(createdAt.getTime() + ttlMinutes * 60_000);
}

export function pairingExpiryCutoff(now = new Date()): Date {
    const ttlMinutes = positiveInt('AUTH_PAIRING_TTL_MINUTES', 10, 1, 60);
    return new Date(now.getTime() - ttlMinutes * 60_000);
}

export function maxPendingAuthPairings(): number {
    return positiveInt(
        'MAX_PENDING_AUTH_PAIRINGS',
        DEFAULT_MAX_PENDING_AUTH_PAIRINGS,
        1,
        100_000,
    );
}

export function pairingExpired(createdAt: Date, now = new Date()): boolean {
    return pairingExpiresAt(createdAt).getTime() <= now.getTime();
}

export function legacyPairingAllowed(): boolean {
    return process.env.AUTH_ALLOW_LEGACY_PAIRING === 'true';
}

export async function allowPairingRate(input: {
    action: 'create' | 'poll' | 'status' | 'approve';
    ip: string;
    publicKeyHex: string;
    accountId?: string;
}): Promise<boolean> {
    const windowMs = positiveInt('AUTH_PAIRING_RATE_WINDOW_SECONDS', 60, 1, 3600) * 1000;
    const max = positiveInt('AUTH_PAIRING_RATE_MAX', 120, 1, 100_000);
    const keyDigest = hashPairingValue(input.publicKeyHex).slice(0, 32);
    const checks = [
        allowAuthRequest(`pair:${input.action}:ip:${hashPairingValue(input.ip).slice(0, 32)}`, { max, windowMs }),
        allowAuthRequest(`pair:${input.action}:key:${keyDigest}`, { max, windowMs }),
    ];
    if (input.accountId) {
        checks.push(allowAuthRequest(`pair:${input.action}:account:${input.accountId}`, { max, windowMs }));
    }
    return (await Promise.all(checks)).every(Boolean);
}
