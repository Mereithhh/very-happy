import * as semver from 'semver';

export type CliVersionPolicySource = 'configured' | 'registry' | 'unavailable';

export interface CliVersionPolicy {
    recommendedVersion: string | null;
    minimumVersion: string | null;
    /**
     * The version machines may install by themselves (B-351), which is a
     * separate question from the version to recommend.
     *
     * B-503 (Owner 2026-09-25): the default policy is `CLI_AUTO_UPDATE_VERSION=latest`
     * — follow npm's `latest` dist-tag, which `publish.yml` moves only after the
     * Linux/macOS/Windows × Node 20/24 smoke matrix for that exact tag is green.
     * The human gate moved from "pin a version by hand" to "promote latest";
     * an explicit exact pin remains the brake/rollback, and unset still means
     * no machine auto-installs anything. Never `next`, never an unverified
     * publish: this value is resolved from the same registry lookup as
     * `recommendedVersion`, so it is null while the registry is unavailable
     * and nothing has been cached.
     */
    autoUpdateVersion: string | null;
    /**
     * B-503: how `autoUpdateVersion` was decided. `pinned` = exact
     * `CLI_AUTO_UPDATE_VERSION`; `latest` = follows the promoted npm `latest`
     * (or an explicit `CLI_RECOMMENDED_VERSION` hold, which caps it); `off` =
     * unset. Older CLIs ignore the field (iron rule 4).
     */
    autoUpdatePolicy: CliAutoUpdatePolicy;
    checkedAt: number;
    source: CliVersionPolicySource;
}

export type CliAutoUpdatePolicy = 'off' | 'pinned' | 'latest';

export interface CliVersionPolicyConfig {
    recommendedVersion: string | null;
    /** Exact pin, or null when unset / following latest. */
    autoUpdateVersion: string | null;
    /** B-503: `CLI_AUTO_UPDATE_VERSION=latest`. */
    autoUpdateFollowsLatest: boolean;
    minimumVersion: string | null;
    registryLookup: boolean;
}

const REGISTRY_URL = 'https://registry.npmjs.org/very-happy-cli/latest';
const CACHE_TTL_MS = 60 * 1000;
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
    const autoUpdateFollowsLatest = env.CLI_AUTO_UPDATE_VERSION?.trim().toLowerCase() === 'latest';
    const autoUpdateVersion = autoUpdateFollowsLatest
        ? null
        : optionalExactVersion(env.CLI_AUTO_UPDATE_VERSION, 'CLI_AUTO_UPDATE_VERSION');
    if (recommendedVersion && minimumVersion && semver.gt(minimumVersion, recommendedVersion)) {
        throw new Error('CLI_MINIMUM_VERSION must not be newer than CLI_RECOMMENDED_VERSION');
    }
    const registryLookup = optionalBoolean(env.CLI_VERSION_REGISTRY_LOOKUP, 'CLI_VERSION_REGISTRY_LOOKUP');
    if (autoUpdateFollowsLatest && !registryLookup && !recommendedVersion) {
        // "latest" has nothing to follow without the lookup; failing at startup
        // beats a fleet that silently never updates.
        throw new Error('CLI_AUTO_UPDATE_VERSION=latest requires CLI_VERSION_REGISTRY_LOOKUP=true (or an explicit CLI_RECOMMENDED_VERSION hold)');
    }
    return {
        recommendedVersion,
        minimumVersion,
        autoUpdateVersion,
        autoUpdateFollowsLatest,
        registryLookup,
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

    private get autoUpdatePolicy(): CliAutoUpdatePolicy {
        if (this.config.autoUpdateFollowsLatest) return 'latest';
        return this.config.autoUpdateVersion ? 'pinned' : 'off';
    }

    /**
     * B-503: the unattended-install target for one resolution. `discovered` is
     * the registry's `latest` (already promote-gated) or null when unknown.
     * An explicit `CLI_RECOMMENDED_VERSION` hold caps "latest" as well: the
     * brake must stop installs, not only banners.
     */
    private autoUpdateVersionFor(discovered: string | null): string | null {
        if (!this.config.autoUpdateFollowsLatest) return this.config.autoUpdateVersion;
        if (this.config.recommendedVersion) return this.config.recommendedVersion;
        return discovered;
    }

    async get(): Promise<CliVersionPolicy> {
        if (this.config.recommendedVersion) {
            return {
                recommendedVersion: this.config.recommendedVersion,
                minimumVersion: this.config.minimumVersion,
                autoUpdateVersion: this.autoUpdateVersionFor(null),
                autoUpdatePolicy: this.autoUpdatePolicy,
                checkedAt: this.now(),
                source: 'configured',
            };
        }
        if (!this.config.registryLookup) {
            return {
                recommendedVersion: null,
                minimumVersion: this.config.minimumVersion,
                autoUpdateVersion: this.autoUpdateVersionFor(null),
                autoUpdatePolicy: this.autoUpdatePolicy,
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
                // Exactly what npm calls `latest`, not `max(minimum, latest)`:
                // a minimum above the registry would otherwise ask machines to
                // install a version that does not exist.
                autoUpdateVersion: this.autoUpdateVersionFor(discovered),
                autoUpdatePolicy: this.autoUpdatePolicy,
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
                // Following latest with no registry answer and no cache means
                // nothing is approved yet — fail closed, never guess.
                autoUpdateVersion: this.autoUpdateVersionFor(null),
                autoUpdatePolicy: this.autoUpdatePolicy,
                checkedAt: this.now(),
                source: 'unavailable',
            };
            return this.cached;
        } finally {
            clearTimeout(timeout);
        }
    }
}
