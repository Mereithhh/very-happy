import { createHash } from 'node:crypto';
import { Counter, Histogram, Registry, register } from 'prom-client';
import { ConnectionDiagnosticEventSchema, type ConnectionDiagnosticEvent } from '@slopus/happy-wire';
import { getCoordinationRedis } from '../release/redisCoordination';

const TTL_MS = 15 * 60_000;
const CAPACITY = 20_000;
/** Refuse new keys at capacity, rather than evict live deduplication entries. */
export function localConnectionClaims(capacity = CAPACITY, ttlMs = TTL_MS, now = Date.now) {
    const entries = new Map<string, number>();
    return async (key: string) => {
        const at = now();
        for (const [entry, expires] of entries) {
            if (expires > at) break;
            entries.delete(entry);
        }
        if (entries.has(key) || entries.size >= capacity) return false;
        entries.set(key, at + ttlMs);
        return true;
    };
}
const localClaim = localConnectionClaims();
export async function sharedConnectionClaim(key: string): Promise<boolean | 'coordination_unavailable' | 'coordination_timeout'> {
    const redis = getCoordinationRedis();
    // Configured multi-replica coordination unavailable: fail closed for metrics,
    // not local counting that could double-count a replay on another replica.
    if (!redis) return process.env.REDIS_URL ? 'coordination_unavailable' : localClaim(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            redis.set(`vh:connection-metrics:${key}`, '1', 'PX', TTL_MS, 'NX').then(result => result === 'OK'),
            new Promise<'coordination_timeout'>(resolve => { timer = setTimeout(() => resolve('coordination_timeout'), 200); }),
        ]);
    } catch { return 'coordination_unavailable'; }
    finally { clearTimeout(timer); }
}

export function createConnectionMetrics(registry: Registry, claim: (key: string) => Promise<boolean | 'coordination_unavailable' | 'coordination_timeout'> = localConnectionClaims()) {
    const labels = ['stage', 'device_class', 'relay_region'] as const;
    const skipped = new Counter({ name: 'browser_connection_metrics_skipped_total', help: 'Telemetry not aggregated; unclaimed includes duplicate or local capacity', labelNames: ['code'], registers: [registry] });
    const results = new Counter({ name: 'browser_connection_stage_results_total', help: 'Received deduplicated browser stage terminal outcomes', labelNames: [...labels, 'outcome'], registers: [registry] });
    const fallbacks = new Counter({ name: 'browser_connection_fallback_total', help: 'Received deduplicated fallback route events', labelNames: [...labels], registers: [registry] });
    const timing = new Counter({ name: 'browser_connection_timing_samples_total', help: 'Received stage timing quality; old clients are unknown', labelNames: [...labels, 'timing'], registers: [registry] });
    const duration = new Histogram({ name: 'browser_connection_stage_duration_seconds', help: 'Uncensored active foreground stage duration only', labelNames: [...labels, 'outcome'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300], registers: [registry] });
    return {
        async observe(userId: string, input: ConnectionDiagnosticEvent): Promise<void> {
            const parsed = ConnectionDiagnosticEventSchema.safeParse(input);
            if (!parsed.success || parsed.data.outcome === 'started') return;
            const event = parsed.data;
            // Same key for success and timeout: one stage cannot vote both ways.
            const kind = event.outcome === 'fallback' ? 'fallback' : 'terminal';
            const key = createHash('sha256').update(JSON.stringify([userId, event.attemptId, event.stage, kind])).digest('hex');
            try {
                const result = await claim(key);
                if (result !== true) { skipped.inc({ code: result === false ? 'unclaimed' : result }); return; }
            } catch { skipped.inc({ code: 'coordination_unavailable' }); return; }
            const dimensions = { stage: event.stage, device_class: event.deviceClass, relay_region: event.relayRegion ?? 'unknown' };
            if (kind === 'fallback') { fallbacks.inc(dimensions); return; }
            results.inc({ ...dimensions, outcome: event.outcome });
            const quality = event.durationMs >= 300_000 ? 'censored' : event.timing ?? 'unknown';
            timing.inc({ ...dimensions, timing: quality });
            if (quality === 'active' && event.visibility === 'visible') {
                duration.observe({ ...dimensions, outcome: event.outcome }, event.durationMs / 1000);
            }
        },
    };
}
export const connectionMetrics = createConnectionMetrics(register, sharedConnectionClaim);
