import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsServer } from './metrics';
let scrapeRegistry: Registry;
vi.mock('@/storage/db', () => ({ db: {$metrics:{prometheus:async()=>''}} }));
vi.mock('@/app/monitoring/metrics2', () => ({register:{metrics:()=>scrapeRegistry.metrics()}}));
import type { ConnectionDiagnosticEvent } from '@slopus/happy-wire';
import { createConnectionMetrics, localConnectionClaims, sharedConnectionClaim } from './connectionMetrics';
const coordination = vi.hoisted(() => ({ get: vi.fn(() => null as any) }));
vi.mock('../release/redisCoordination', () => ({ getCoordinationRedis: coordination.get }));
const event: ConnectionDiagnosticEvent = {
    attemptId: 'db48f13c-29f5-49f3-8f45-5e6bc59caeaa', at: 1, stage: 'terminal_open', outcome: 'success',
    durationMs: 1200, deviceClass: 'mobile', visibility: 'visible', client: 'web/abcdef12', relayRegion: 'sg', timing: 'active',
};
describe('connection metrics aggregation', () => {
    it('deduplicates retries and conflicting terminal outcomes while counting fallback separately', async () => {
        const registry = new Registry(); const metrics = createConnectionMetrics(registry);
        await metrics.observe('private-user', {...event, outcome: 'timeout'});
        await metrics.observe('private-user', event);
        await metrics.observe('private-user', {...event, outcome: 'fallback'});
        await metrics.observe('private-user', {...event, outcome: 'fallback'});
        const text = await registry.metrics();
        expect(text).toContain('outcome="timeout"} 1');
        expect(text).not.toContain('outcome="success"');
        expect(text).toContain('browser_connection_fallback_total{stage="terminal_open",device_class="mobile",relay_region="sg"} 1');
        expect(text).not.toContain('private-user'); expect(text).not.toContain(event.attemptId); expect(text).not.toContain('abcdef12');
    });
    it('excludes old, background and censored durations; serves active latency via real HTTP scrape', async () => {
        const registry = new Registry(); const metrics = createConnectionMetrics(registry);
        await metrics.observe('a', event);
        await metrics.observe('b', {...event, timing: undefined, relayRegion: undefined});
        await metrics.observe('c', {...event, timing: 'background'});
        await metrics.observe('d', {...event, durationMs: 300_000});
        scrapeRegistry = registry;
        const server = await createMetricsServer();
        await server.listen({port:0,host:'127.0.0.1'});
        try {
            const response = await fetch(`http://127.0.0.1:${(server.server.address() as any).port}/metrics`);
            const text = await response.text();
            expect(text).toContain('browser_connection_stage_duration_seconds_count{stage="terminal_open",device_class="mobile",relay_region="sg",outcome="success"} 1');
            expect(text).toContain('timing="unknown"} 1'); expect(text).toContain('timing="censored"} 1'); expect(text).toContain('timing="background"} 1');
        } finally { await server.close(); }
    });
    it('bounds local memory without evicting dedup keys and permits new samples after TTL', async () => {
        let now = 0; const claim = localConnectionClaims(1, 100, () => now);
        expect(await claim('a')).toBe(true); expect(await claim('b')).toBe(false); expect(await claim('a')).toBe(false);
        now = 101; expect(await claim('b')).toBe(true);
    });
    it('drops failed claims and invalid categories without throwing or creating labels', async () => {
        const registry = new Registry(); const metrics = createConnectionMetrics(registry, async () => { throw Error('offline'); });
        await expect(metrics.observe('a', event)).resolves.toBeUndefined();
        await expect(metrics.observe('a', {...event, relayRegion: 'private-region' as any})).resolves.toBeUndefined();
        expect(await registry.metrics()).not.toContain('private-region');
        expect(await registry.metrics()).not.toContain('outcome="success"');
    });
});

it('uses shared Redis NX+TTL and bounds a hung coordination request', async () => {
    const seen=new Set<string>();
    const set=vi.fn(async (key:string) => {if(seen.has(key))return null;seen.add(key);return 'OK';});
    coordination.get.mockReturnValue({set});
    expect(await sharedConnectionClaim('hash')).toBe(true);expect(await sharedConnectionClaim('hash')).toBe(false);
    expect(set).toHaveBeenCalledWith('vh:connection-metrics:hash','1','PX',900000,'NX');
    vi.useFakeTimers();coordination.get.mockReturnValue({set:()=>new Promise(()=>{})});
    const pending=sharedConnectionClaim('hung');await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe('coordination_timeout');vi.useRealTimers();coordination.get.mockReturnValue(null);
});
