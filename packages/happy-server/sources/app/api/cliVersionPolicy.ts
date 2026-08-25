import * as semver from 'semver';

export type CliVersionPolicySource = 'configured' | 'registry' | 'unavailable';

export interface CliVersionPolicy {
    recommendedVersion: string | null;
    minimumVersion: string | null;
    checkedAt: number;
    source: CliVersionPolicySource;
}

export interface CliVersionPolicyConfig {
    recommendedVersion: string | null;
    minimumVersion: string | null;
    registryLookup: boolean;
}

const REGISTRY_URL = 'https://registry.npmjs.org/very-happy-cli/latest';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 2_000;

function optionalExactVersion(raw: string | undefined, name: string): string | null {
    const value = raw?.trim();
    if (!value) return null;
    const valid = semver.valid(value);
    if (!valid) throw new Error(`${name} must be an exact semantic version`);
    return valid;
}

function optionalBoolean(raw: string | undefined, name: string): boolean {
    const value = raw?.trim().toLowerCase();
    if (!value) return false;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${name} must be true or false`);
}

export function resolveCliVersionPolicyConfig(env: NodeJS.ProcessEnv = process.env): CliVersionPolicyConfig {
    const recommendedVersion = optionalExactVersion(env.CLI_RECOMMENDED_VERSION, 'CLI_RECOMMENDED_VERSION');
    const minimumVersion = optionalExactVersion(env.CLI_MINIMUM_VERSION, 'CLI_MINIMUM_VERSION');
    if (recommendedVersion && minimumVersion && semver.gt(minimumVersion, recommendedVersion)) {
        throw new Error('CLI_MINIMUM_VERSION must not be newer than CLI_RECOMMENDED_VERSION');
    }
    return {
        recommendedVersion,
        minimumVersion,
        registryLookup: optionalBoolean(env.CLI_VERSION_REGISTRY_LOOKUP, 'CLI_VERSION_REGISTRY_LOOKUP'),
    };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Relay-owned CLI policy. The registry is discovery only: operators can pin a
 * reviewed recommended version or disable the outbound lookup entirely.
 * Failures retain the last successful value and never block API traffic.
 */
export class CliVersionPolicyProvider {
    private cached: CliVersionPolicy | null = null;
    private inFlight: Promise<CliVersionPolicy> | null = null;
    private retryAfter = 0;

    constructor(
        private readonly config: CliVersionPolicyConfig,
        private readonly fetcher: FetchLike = fetch,
        private readonly now: () => number = Date.now,
    ) {}

    async get(): Promise<CliVersionPolicy> {
        if (this.config.recommendedVersion) {
            return {
                recommendedVersion: this.config.recommendedVersion,
                minimumVersion: this.config.minimumVersion,
                checkedAt: this.now(),
                source: 'configured',
            };
        }
        if (!this.config.registryLookup) {
            return {
                recommendedVersion: null,
                minimumVersion: this.config.minimumVersion,
                checkedAt: this.now(),
                source: 'unavailable',
            };
        }
        const now = this.now();
        const ttl = this.cached?.source === 'unavailable' ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
        if (this.cached && (now < this.retryAfter || now - this.cached.checkedAt < ttl)) return this.cached;
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.lookupRegistry().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async lookupRegistry(): Promise<CliVersionPolicy> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
        try {
            const response = await this.fetcher(REGISTRY_URL, {
                signal: controller.signal,
                headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`registry returned ${response.status}`);
            const body = await response.json() as { version?: unknown };
            const discovered = typeof body.version === 'string' ? semver.valid(body.version.trim()) : null;
            if (!discovered) throw new Error('registry returned an invalid version');
            const recommendedVersion = this.config.minimumVersion && semver.gt(this.config.minimumVersion, discovered)
                ? this.config.minimumVersion
                : discovered;
            this.cached = {
                recommendedVersion,
                minimumVersion: this.config.minimumVersion,
                checkedAt: this.now(),
                source: 'registry',
            };
            this.retryAfter = 0;
            return this.cached;
        } catch {
            this.retryAfter = this.now() + FAILURE_CACHE_TTL_MS;
            if (this.cached) return this.cached;
            this.cached = {
                recommendedVersion: null,
                minimumVersion: this.config.minimumVersion,
                checkedAt: this.now(),
                source: 'unavailable',
            };
            return this.cached;
        } finally {
            clearTimeout(timeout);
        }
    }
}
