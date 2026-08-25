import { RelayCandidateSchema, type RelayCandidate } from '@slopus/happy-wire';

export const RELAY_ASSIGNMENT_TTL_MS = 75_000;
export const RELAY_TOKEN_TTL_SECONDS = 10 * 60;

function normalizeRelayUrl(value: string): string {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        !/^\/*$/u.test(parsed.pathname) || parsed.search || parsed.hash) {
        throw new Error('relay url must be an http(s) origin without credentials, path, query, or fragment');
    }
    return parsed.origin;
}

export function parseRelayCandidates(raw: string | undefined): RelayCandidate[] {
    if (!raw?.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('HAPPY_RELAYS_JSON must be an array');
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    return parsed.map((item) => {
        const candidate = RelayCandidateSchema.parse(item);
        const normalized = { ...candidate, url: normalizeRelayUrl(candidate.url) };
        if (seenIds.has(normalized.id)) throw new Error(`duplicate relay id: ${normalized.id}`);
        if (seenUrls.has(normalized.url)) throw new Error(`duplicate relay url: ${normalized.url}`);
        seenIds.add(normalized.id);
        seenUrls.add(normalized.url);
        return normalized;
    });
}

export function relayFeatureConfig(env: NodeJS.ProcessEnv = process.env): {
    enabled: boolean;
    candidates: RelayCandidate[];
    tokenSecret?: string;
} {
    const candidates = parseRelayCandidates(env.HAPPY_RELAYS_JSON);
    const tokenSecret = env.RELAY_TOKEN_SECRET?.trim() || undefined;
    if (candidates.length > 0 && (!tokenSecret || Buffer.byteLength(tokenSecret, 'utf8') < 32)) {
        throw new Error('RELAY_TOKEN_SECRET must be at least 32 bytes when regional relays are configured');
    }
    return { enabled: candidates.length > 0, candidates, tokenSecret };
}
