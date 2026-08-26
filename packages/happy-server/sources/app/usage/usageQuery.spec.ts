import { describe, expect, it } from 'vitest';
import { aggregateUsageReports, serializeUsageReports, type UsageQueryReport } from './usageQuery';

const makeReport = (updatedAt: string, total: number, key = 'usage:codex:session'): UsageQueryReport => ({
    key, sessionId: 'session-1', updatedAt: new Date(updatedAt),
    data: { tokens: { total, input: total - 1, output: 1 }, cost: { total: 0 } },
});

describe('usage query aggregation', () => {
    it('groups snapshots by updatedAt and preserves raw report metadata', () => {
        const reports = [makeReport('2026-08-26T01:15:00Z', 10), makeReport('2026-08-26T01:45:00Z', 20, 'claude-session')];
        const buckets = aggregateUsageReports(reports, 'hour');
        expect(buckets).toHaveLength(1);
        expect(buckets[0]).toMatchObject({ tokens: { total: 30 }, reportCount: 2 });
        expect(serializeUsageReports(reports)[1]).toMatchObject({
            key: 'claude-session', sessionId: 'session-1', timestamp: 1787708700,
        });
    });
});
