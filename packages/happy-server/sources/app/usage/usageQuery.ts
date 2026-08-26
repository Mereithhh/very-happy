type UsagePayload = { tokens: Record<string, number>; cost: Record<string, number> };

export type UsageQueryReport = {
    key: string;
    sessionId: string | null;
    updatedAt: Date;
    data: UsagePayload;
};

export type UsageBucket = {
    timestamp: number;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    reportCount: number;
};

export function usageBucketTimestamp(date: Date, groupBy: 'hour' | 'day'): number {
    const bucket = groupBy === 'hour'
        ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0)
        : new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    return Math.floor(bucket.getTime() / 1000);
}

export function aggregateUsageReports(reports: UsageQueryReport[], groupBy: 'hour' | 'day'): UsageBucket[] {
    const aggregated = new Map<number, UsageBucket>();
    for (const report of reports) {
        const timestamp = usageBucketTimestamp(report.updatedAt, groupBy);
        const bucket = aggregated.get(timestamp) ?? { timestamp, tokens: {}, cost: {}, reportCount: 0 };
        bucket.reportCount++;
        for (const [key, value] of Object.entries(report.data.tokens)) {
            if (Number.isFinite(value)) bucket.tokens[key] = (bucket.tokens[key] ?? 0) + value;
        }
        for (const [key, value] of Object.entries(report.data.cost)) {
            if (Number.isFinite(value)) bucket.cost[key] = (bucket.cost[key] ?? 0) + value;
        }
        aggregated.set(timestamp, bucket);
    }
    return [...aggregated.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function serializeUsageReports(reports: UsageQueryReport[]) {
    return reports.map((report) => ({
        key: report.key,
        sessionId: report.sessionId,
        timestamp: Math.floor(report.updatedAt.getTime() / 1000),
        tokens: report.data.tokens,
        cost: report.data.cost,
    }));
}
