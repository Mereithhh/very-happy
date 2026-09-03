import { register, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';
import { db } from '@/storage/db';
import { forever } from '@/utils/forever';
import { delay } from '@/utils/delay';
import { shutdownSignal } from '@/utils/shutdown';
import { Socket } from 'socket.io';
import { resolveSignupPolicy } from '@/app/auth/signupPolicy';

// Global default labels — applied to ALL metrics at scrape time
register.setDefaultLabels({ app: 'happy-server' });
if (!register.getSingleMetric('process_resident_memory_bytes')) {
    collectDefaultMetrics({ register });
}

// Expected client_type values (trust whatever the client sends):
// cli-coding-session, cli-daemon, cli-control-plane, ios, android, web, desktop

interface ClientLabels {
    client: string;
    client_type: string;
}

function parseClientLabels(raw: string | undefined | null): ClientLabels {
    if (!raw) return { client: 'unknown', client_type: 'unknown' };
    const type = raw.split('/')[0].toLowerCase();
    return { client: raw, client_type: type };
}

/**
 * Extract standard metric labels from a Socket.IO socket.
 * Spread into any metric .inc() / .observe() call.
 */
export function getMetricsLabelsFromSocket(socket: Socket): ClientLabels {
    return parseClientLabels(socket.data.happyClient as string);
}

/**
 * Extract standard metric labels from a Fastify request.
 * Spread into any metric .inc() / .observe() call.
 */
export function getMetricsLabelsFromRequest(request: { headers: Record<string, string | string[] | undefined> }): ClientLabels {
    return parseClientLabels(request.headers['x-happy-client'] as string);
}

// Application metrics
export const websocketConnectionsGauge = new Gauge({
    name: 'websocket_connections_total',
    help: 'Number of active WebSocket connections',
    labelNames: ['type', 'client', 'client_type'] as const,
    registers: [register]
});

export const sessionAliveEventsCounter = new Counter({
    name: 'session_alive_events_total',
    help: 'Total number of session-alive events',
    registers: [register]
});

export const machineAliveEventsCounter = new Counter({
    name: 'machine_alive_events_total',
    help: 'Total number of machine-alive events',
    registers: [register]
});

export const sessionCacheCounter = new Counter({
    name: 'session_cache_operations_total',
    help: 'Total session cache operations',
    labelNames: ['operation', 'result'] as const,
    registers: [register]
});

export const databaseUpdatesSkippedCounter = new Counter({
    name: 'database_updates_skipped_total',
    help: 'Number of database updates skipped due to debouncing',
    labelNames: ['type'] as const,
    registers: [register]
});

export const websocketEventsCounter = new Counter({
    name: 'websocket_events_total',
    help: 'Total WebSocket events received by type',
    labelNames: ['event_type', 'client', 'client_type'] as const,
    registers: [register]
});

/**
 * B-309: live session-stream frames, by what happened to them. Drafts are
 * dropped rather than disconnecting the producer, so without a counter a
 * throttled or disabled relay is completely invisible — the symptom on the
 * client is just "streaming feels choppy" with nothing to check.
 */
export const sessionStreamFramesCounter = new Counter({
    name: 'session_stream_frames_total',
    help: 'Live session stream frames by outcome (relayed / dropped)',
    labelNames: ['outcome'] as const,
    registers: [register]
});

export const httpRequestsCounter = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status', 'client', 'client_type'] as const,
    registers: [register]
});

export const httpRequestDurationHistogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status', 'client', 'client_type'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [register]
});

export const releaseSlotReadyGauge = new Gauge({
    name: 'release_slot_ready',
    help: 'Whether this immutable release slot currently passes readiness',
    labelNames: ['slot', 'release'] as const,
    registers: [register]
});

export const releaseDrainingGauge = new Gauge({
    name: 'release_draining',
    help: 'Whether this immutable release slot is draining',
    labelNames: ['slot', 'release'] as const,
    registers: [register]
});

export const releaseLocalConnectionsGauge = new Gauge({
    name: 'release_local_connections',
    help: 'Local Socket.IO connections held by a release slot',
    labelNames: ['slot', 'release'] as const,
    registers: [register]
});

export const releaseInflightHttpGauge = new Gauge({
    name: 'release_inflight_http',
    help: 'In-flight non-admin HTTP requests on a release slot',
    labelNames: ['slot', 'release'] as const,
    registers: [register]
});

export const releaseInflightRpcGauge = new Gauge({
    name: 'release_inflight_rpc',
    help: 'In-flight RPC calls on a release slot',
    labelNames: ['slot', 'release'] as const,
    registers: [register]
});

export const releaseHandoverCounter = new Counter({
    name: 'release_handover_total',
    help: 'Client release handovers by client type and result',
    labelNames: ['client_type', 'result'] as const,
    registers: [register]
});

export const releaseHandoverDuration = new Histogram({
    name: 'release_handover_duration_seconds',
    help: 'Client-observed make-before-break handover duration',
    labelNames: ['client_type', 'result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register]
});

// Database count metrics
export const databaseRecordCountGauge = new Gauge({
    name: 'database_records_total',
    help: 'Total number of records in database tables',
    labelNames: ['table'] as const,
    registers: [register]
});

export const registeredAccountsGauge = new Gauge({
    name: 'registered_accounts_total',
    help: 'Exact number of registered Accounts (use max across replicas)',
    registers: [register]
});

export const activeLoginSessionsGauge = new Gauge({
    name: 'active_login_sessions_total',
    help: 'Exact number of non-revoked, non-expired Cloud login sessions',
    registers: [register]
});

export const signupCapacityRemainingGauge = new Gauge({
    name: 'signup_capacity_remaining',
    help: 'Remaining Account slots; -1 means unlimited',
    registers: [register]
});

export const signupRejectionsCounter = new Counter({
    name: 'signup_rejections_total',
    help: 'New Account creation attempts rejected by signup policy',
    labelNames: ['reason', 'provider'] as const,
    registers: [register]
});

type EstimatedCountRow = {
    estimated_count: bigint | number | null;
};

type ExactCountRow = {
    count: bigint | number | null;
};

async function getEstimatedRecordCount(tableName: string): Promise<number> {
    const rows = await db.$queryRaw<EstimatedCountRow[]>`
        SELECT GREATEST(reltuples, 0)::bigint AS estimated_count
        FROM pg_class
        WHERE oid = to_regclass(${tableName})
    `;
    const estimatedCount = rows[0]?.estimated_count ?? 0;
    return Number(estimatedCount);
}

// Database metrics updater
export async function updateDatabaseMetrics(): Promise<void> {
    // Use catalog estimates instead of exact COUNT(*). Exact counts are full
    // scans in Postgres and this updater runs once a minute.
    const [accountCount, sessionCount, messageCount, machineCount, exactAccountCount, activeLoginSessionRows] = await Promise.all([
        getEstimatedRecordCount('"Account"'),
        getEstimatedRecordCount('"Session"'),
        getEstimatedRecordCount('"SessionMessage"'),
        getEstimatedRecordCount('"Machine"'),
        db.account.count(),
        // Production bind-mounts sources and migrations onto an image whose
        // generated Prisma Client can predate this model. Keep new-table reads
        // on raw SQL so deploying a migration never requires image regeneration.
        db.$queryRawUnsafe<ExactCountRow[]>(
            `SELECT COUNT(*)::bigint AS "count" FROM "AccountLoginSession"
             WHERE "revokedAt" IS NULL AND "expiresAt" > now()`,
        ),
    ]);
    const activeLoginSessions = Number(activeLoginSessionRows[0]?.count ?? 0);

    // Update metrics
    databaseRecordCountGauge.set({ table: 'accounts' }, accountCount);
    databaseRecordCountGauge.set({ table: 'sessions' }, sessionCount);
    databaseRecordCountGauge.set({ table: 'messages' }, messageCount);
    databaseRecordCountGauge.set({ table: 'machines' }, machineCount);
    registeredAccountsGauge.set(exactAccountCount);
    activeLoginSessionsGauge.set(activeLoginSessions);
    const maxAccounts = resolveSignupPolicy().maxAccounts;
    signupCapacityRemainingGauge.set(maxAccounts === null ? -1 : Math.max(0, maxAccounts - exactAccountCount));
}

export function startDatabaseMetricsUpdater(): void {
    forever('database-metrics-updater', async () => {
        await updateDatabaseMetrics();
        
        // Wait 60 seconds before next update
        await delay(60 * 1000, shutdownSignal);
    });
}

// Redis stream lag — how far behind this pod's reader is from the stream head
export const redisStreamLagMsGauge = new Gauge({
    name: 'redis_stream_lag_ms',
    help: 'Milliseconds between this pod read cursor and stream HEAD',
    registers: [register]
});

// Export the register for combining metrics
export { register };
