import fastify from 'fastify';
import { db } from '@/storage/db';
import { register } from '@/app/monitoring/metrics2';
import { log } from '@/utils/log';
import { resolveMetricsServerConfig } from './metricsConfig';

export async function createMetricsServer() {
    const app = fastify({
        logger: false // Disable logging for metrics server
    });

    app.get('/metrics', async (_request, reply) => {
        try {
            // Get Prisma metrics in Prometheus format
            const prismaMetrics = await db.$metrics.prometheus();
            
            // Get custom application metrics
            const appMetrics = await register.metrics();
            
            // Combine both metrics
            const combinedMetrics = prismaMetrics + '\n' + appMetrics;
            
            reply.type('text/plain; version=0.0.4; charset=utf-8');
            reply.send(combinedMetrics);
        } catch (error) {
            log({ module: 'metrics', level: 'error', error }, 'Error generating metrics');
            reply.code(500).send('Internal Server Error');
        }
    });

    app.get('/health', async (_request, reply) => {
        reply.send({ status: 'ok', timestamp: new Date().toISOString() });
    });

    return app;
}

export async function startMetricsServer(): Promise<void> {
    const config = resolveMetricsServerConfig();
    if (!config.enabled) {
        log({ module: 'metrics' }, 'Metrics server disabled (set METRICS_ENABLED=true to enable)');
        return;
    }

    const app = await createMetricsServer();

    try {
        await app.listen({ port: config.port, host: config.host });
        log({ module: 'metrics' }, `Metrics server listening on ${config.host}:${config.port}`);
    } catch (error) {
        // Don't take the whole API down if the metrics port is taken — that's
        // a common dev situation (orphaned process, another tool on 9090,
        // multiple checkouts running side by side). The main API is what
        // users actually need; metrics is best-effort observability.
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EADDRINUSE') {
            log({ module: 'metrics', level: 'warn' }, `Metrics endpoint ${config.host}:${config.port} already in use — continuing without metrics. Set METRICS_PORT or METRICS_ENABLED=false to silence.`);
            try { await app.close(); } catch { /* noop */ }
            return;
        }
        log({ module: 'metrics', level: 'error', error }, 'Failed to start metrics server');
        throw error;
    }
}
