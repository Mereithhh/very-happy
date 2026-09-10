import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForRecommendation } from './check-recommended.mjs';

function harness(reply) {
    let clock = 1_000_000, calls = 0, waits = 0;
    return {
        options: {
            now: () => clock, sleep: async ms => { clock += ms; waits++; },
            timeoutMs: 60_000, intervalMs: 15_000, log: () => {},
            fetcher: async (url, init) => {
                calls++;
                assert.equal(init.cache, 'no-store');
                const result = reply({ registry: url.includes('registry.npmjs.org'), waits, clock, url });
                if (result instanceof Error) throw result;
                return new Response(JSON.stringify(result));
            },
        },
        waits: () => waits, calls: () => calls,
    };
}
const policy = (version, clock, source = 'registry') => ({ recommendedVersion: version, checkedAt: clock, source, autoUpdateVersion: '0.2.100' });
test('waits for cached old recommendation, then verifies exact promoted release', async () => {
    const h = harness(({ registry, waits, clock, url }) => {
        if (registry) return { version: '0.2.133' };
        assert.match(url, /releaseCheck=/);
        return policy(waits ? '0.2.133' : '0.2.132', clock);
    });
    await waitForRecommendation('0.2.133', h.options);
    assert.equal(h.waits(), 1);
});
test('explicit hold fails without retrying or mutating the pin', async () => {
    const h = harness(({ registry, clock }) => registry ? { version: '0.2.133' } : policy('0.2.132', clock, 'configured'));
    await assert.rejects(waitForRecommendation('0.2.133', h.options), /explicit CLI_RECOMMENDED_VERSION/);
    assert.equal(h.waits(), 0);
});
for (const problem of ['old-registry', 'stale', 'future', 'unavailable', 'network']) {
    test(`does not report success for ${problem}`, async () => {
        const h = harness(({ registry, clock }) => {
            if (problem === 'network') return new Error('offline');
            if (registry) return { version: problem === 'old-registry' ? '0.2.132' : '0.2.133' };
            return policy('0.2.133', problem === 'stale' ? 0 : problem === 'future' ? clock + 120_000 : clock,
                problem === 'unavailable' ? 'unavailable' : 'registry');
        });
        await assert.rejects(waitForRecommendation('0.2.133', h.options), /timed out/);
        assert.equal(h.waits(), 4);
    });
}
test('recovers from transient network errors; repeat verification is idempotent', async () => {
    const h = harness(({ registry, waits, clock }) => !waits ? new Error('offline') : registry ? { version: '0.2.133' } : policy('0.2.133', clock));
    await waitForRecommendation('0.2.133', h.options);
    await waitForRecommendation('0.2.133', h.options);
    assert.equal(h.waits(), 1);
});
test('invalid target never contacts a service', async () => {
    const h = harness(() => ({}));
    await assert.rejects(waitForRecommendation('latest', h.options), /exact release/);
    assert.equal(h.calls(), 0);
});
