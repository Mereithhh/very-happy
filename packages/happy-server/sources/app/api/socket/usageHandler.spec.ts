import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type Report = { id: string; accountId: string; sessionId: string | null; key: string; data: unknown; createdAt: Date; updatedAt: Date };
    const state = {
        reports: [] as Report[],
        sessions: [] as Array<{ id: string; accountId: string }>,
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        nextId: 1,
    };
    const resetState = () => {
        state.reports = [];
        state.sessions = [];
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
        state.nextId = 1;
    };
    const usageReport = {
        findFirst: vi.fn(async ({ where }: any) => state.reports.find((row) => (
            row.accountId === where.accountId && row.sessionId === where.sessionId && row.key === where.key
        )) ?? null),
        count: vi.fn(async ({ where }: any) => state.reports.filter((row) => row.accountId === where.accountId).length),
        update: vi.fn(async ({ where, data }: any) => {
            const row = state.reports.find((item) => item.id === where.id)!;
            Object.assign(row, data, { updatedAt: data.updatedAt ?? new Date() });
            return row;
        }),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date();
            const row: Report = { id: `usage-${state.nextId++}`, ...data, createdAt: now, updatedAt: now };
            state.reports.push(row);
            return row;
        }),
    };
    const session = {
        findFirst: vi.fn(async ({ where }: any) => state.sessions.find((row) => row.id === where.id && row.accountId === where.accountId) ?? null),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            const key = String(args[0]);
            const count = (state.rateCountByKey.get(key) ?? 0) + Number(args[3] ?? 1);
            state.rateCountByKey.set(key, count);
            return [{ count }];
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = { usageReport, session, $queryRawUnsafe: rawQuery, $executeRawUnsafe: vi.fn(async () => 0) };
    const dbMock = {
        ...tx,
        $transaction: vi.fn(async (fn: any) => {
            const previous = state.transactionTail;
            let release!: () => void;
            state.transactionTail = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            try { return await fn(tx); } finally { release(); }
        }),
    };
    return { state, dbMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitEphemeral: vi.fn() },
    buildUsageEphemeral: vi.fn(() => ({})),
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { USAGE_KEY_MAX_BYTES, usageReportSchema } from '@/app/usage/usageStore';
import { usageHandler } from './usageHandler';

function createSocket(userId = 'user-1') {
    const handlers = new Map<string, (...args: any[]) => any>();
    usageHandler(userId, { on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler) } as any);
    return {
        invoke(data: unknown) {
            return new Promise<any>((resolve, reject) => {
                Promise.resolve(handlers.get('usage-report')?.(data, resolve)).catch(reject);
            });
        },
    };
}

function usage(key: string, sessionId?: string) {
    return {
        key,
        ...(sessionId ? { sessionId } : {}),
        tokens: { total: 10, input: 4, output: 6 },
        cost: { total: 0.01 },
    };
}

describe('usage report account quota', () => {
    beforeEach(() => {
        resetState();
        process.env.MAX_USAGE_REPORT_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_USAGE_REPORTS_PER_ACCOUNT;
    });
    afterEach(() => {
        delete process.env.MAX_USAGE_REPORT_WRITES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_USAGE_REPORTS_PER_ACCOUNT;
    });

    it('bounds the unique key by UTF-8 bytes and rejects non-finite metrics', async () => {
        const exact = 'é'.repeat(USAGE_KEY_MAX_BYTES / 2);
        const over = `${exact}a`;
        expect(usageReportSchema.safeParse(usage(exact)).success).toBe(true);
        expect(usageReportSchema.safeParse(usage(over)).success).toBe(false);
        expect((await createSocket().invoke(usage(exact))).success).toBe(true);
        expect(await createSocket().invoke(usage(over))).toEqual({ success: false, error: 'invalid_usage_report' });
        expect(await createSocket().invoke({ ...usage('nan'), tokens: { total: Number.NaN } }))
            .toEqual({ success: false, error: 'invalid_usage_report' });
    });

    it('atomically permits one new unique key across two sockets at the count cap', async () => {
        process.env.MAX_USAGE_REPORTS_PER_ACCOUNT = '1';
        const leftSocket = createSocket();
        const rightSocket = createSocket();
        const [left, right] = await Promise.all([leftSocket.invoke(usage('left')), rightSocket.invoke(usage('right'))]);
        expect(state.reports).toHaveLength(1);
        const successes = Number(left.success) + Number(right.success);
        expect(successes).toBe(1);
        const rejected = left.success ? right : left;
        expect(rejected.error).toBe('usage_report_count_quota_exceeded');
    });

    it('updates one nullable-session unique key instead of accumulating rows', async () => {
        process.env.MAX_USAGE_REPORTS_PER_ACCOUNT = '1';
        const [left, right] = await Promise.all([
            createSocket().invoke(usage('account-total')),
            createSocket().invoke({ ...usage('account-total'), tokens: { total: 12 } }),
        ]);
        expect(left.success).toBe(true);
        expect(right.success).toBe(true);
        expect(state.reports).toHaveLength(1);
        expect((state.reports[0].data as any).tokens.total).toBe(12);
    });

    it('shares a stable database-backed rate across sockets', async () => {
        process.env.MAX_USAGE_REPORT_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        expect((await createSocket().invoke(usage('first'))).success).toBe(true);
        const second = await createSocket().invoke(usage('second'));
        expect(second).toEqual({ success: false, error: 'usage_report_rate_quota_exceeded' });
        expect(state.reports).toHaveLength(1);
    });

    it('verifies optional session ownership inside the account-locked transaction', async () => {
        const missing = await createSocket().invoke(usage('session', 'foreign-session'));
        expect(missing).toEqual({ success: false, error: 'Session not found' });
        expect(state.reports).toHaveLength(0);
    });
});
