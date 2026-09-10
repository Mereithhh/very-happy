#!/usr/bin/env node
// Run after smoke-gated promotion. Publication is irreversible; verification
// failures must stay visible without changing pins or automatic-install policy.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function waitForRecommendation(version, {
    origin = 'https://veryhappy.dev', fetcher = fetch,
    now = Date.now, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs = 600_000, intervalMs = 15_000, log = console.log,
} = {}) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
        throw new Error('Expected an exact release version X.Y.Z');
    }
    const deadline = now() + timeoutMs;
    let last = 'No policy response';
    do {
        let policy;
        try {
            const read = async (url) => {
                const res = await fetcher(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
                return res.json();
            };
            // Bypass intermediary policy caches; the server's shared cache still
            // bounds outbound registry traffic. Neither URL accepts a target version.
            const url = new URL('/v1/version/cli', origin);
            url.searchParams.set('releaseCheck', String(now()));
            const [relay, registry] = await Promise.all([
                read(url.href), read('https://registry.npmjs.org/very-happy-cli/latest'),
            ]);
            policy = relay;
            const fresh = Number.isFinite(relay?.checkedAt)
                && relay.checkedAt <= now() + 60_000 && now() - relay.checkedAt <= 300_000;
            if (registry?.version === version && relay?.recommendedVersion === version
                && ['registry', 'configured'].includes(relay?.source) && fresh) {
                log(`Verified: npm latest and relay recommendation both equal ${version}.`);
                return;
            }
            last = `npm latest=${registry?.version ?? 'unavailable'}, relay=${relay?.recommendedVersion ?? 'unavailable'}, source=${relay?.source ?? 'unavailable'}, fresh=${fresh}`;
        } catch (error) {
            last = error.message;
        }
        if (policy?.source === 'configured' && policy.recommendedVersion !== version) {
            throw new Error(`Recommendation held by explicit CLI_RECOMMENDED_VERSION=${policy.recommendedVersion}; published ${version}. Pin preserved; resolve the hold before rerunning verification.`);
        }
        log(`Waiting for ${version}: ${last}`);
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(intervalMs, remaining));
    } while (now() <= deadline);
    throw new Error(`Recommendation verification timed out for ${version}: ${last}. npm publication is not rolled back; fix the policy/registry connection and rerun.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await waitForRecommendation(process.argv[2], { origin: process.env.VH_PUBLIC_ORIGIN ?? 'https://veryhappy.dev' });
        const line = `CLI ${process.argv[2]} is published and recommended by the relay.\n`;
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line);
    } catch (error) {
        console.error(`::error::${error.message}`);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CLI recommendation verification failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
