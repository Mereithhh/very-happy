import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ shutdown: new Map<string, () => Promise<void>>() }));
vi.mock('./standalone', () => ({ runMigrations: vi.fn() }));
vi.mock('./storage/db', () => ({
    closeDatabase: vi.fn(),
    db: { $connect: vi.fn(), $metrics: { prometheus: async () => 'prisma_test_metric 1' } },
}));
vi.mock('./modules/encrypt', () => ({ initEncrypt: vi.fn() }));
vi.mock('./modules/github', () => ({ initGithub: vi.fn() }));
vi.mock('./storage/files', () => ({ loadFiles: vi.fn() }));
vi.mock('./app/auth/auth', () => ({ auth: { init: vi.fn() } }));
vi.mock('./app/presence/sessionCache', () => ({ activityCache: { shutdown: vi.fn() } }));
vi.mock('./app/api/api', () => ({ startApi: vi.fn(async () => ({ port: 3005, host: '127.0.0.1' })) }));
vi.mock('./app/monitoring/metrics2', () => ({
    startDatabaseMetricsUpdater: vi.fn(), register: { metrics: async () => 'app_test_metric 2' },
}));
vi.mock('./app/presence/timeout', () => ({ startTimeout: vi.fn() }));
vi.mock('./utils/shutdown', () => ({
    onShutdown: (name: string, handler: () => Promise<void>) => state.shutdown.set(name, handler),
}));
vi.mock('./utils/log', () => ({ log: vi.fn() }));

import { startServer } from './index';

// Exercise the exported production startup and real metrics HTTP listener;
// unrelated database/API/background services are isolated above.
describe('standalone startup metrics listener', () => {
    afterEach(async () => {
        await state.shutdown.get('metrics')?.();
        state.shutdown.clear();
        vi.unstubAllEnvs();
    });

    async function start() {
        vi.stubEnv('DB_PROVIDER', 'postgres');
        vi.stubEnv('PGLITE_DIR', '');
        vi.stubEnv('HANDY_MASTER_SECRET', '');
        return startServer({ pgliteDir: 'unused', masterSecret: 'test-only' });
    }

    async function portReservation() {
        const reservation = createServer();
        await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
        const port = (reservation.address() as { port: number }).port;
        return { port, close: () => new Promise<void>((resolve) => reservation.close(() => resolve())) };
    }

    it('starts configured metrics through startServer and closes it on shutdown', async () => {
        const reservation = await portReservation();
        await reservation.close();
        vi.stubEnv('METRICS_ENABLED', 'true');
        vi.stubEnv('METRICS_HOST', '127.0.0.1');
        vi.stubEnv('METRICS_PORT', String(reservation.port));
        await expect(start()).resolves.toEqual({ port: 3005, host: '127.0.0.1' });
        const url = `http://127.0.0.1:${reservation.port}`;
        const response = await fetch(`${url}/metrics`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('prisma_test_metric 1\napp_test_metric 2');
        expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ status: 'ok' });
        expect(state.shutdown.has('metrics')).toBe(true);
        await state.shutdown.get('metrics')!();
        state.shutdown.delete('metrics');
        await expect(fetch(`${url}/health`)).rejects.toThrow();
    });

    it('keeps metrics disabled by default', async () => {
        vi.stubEnv('METRICS_ENABLED', undefined);
        await start();
        expect(state.shutdown.has('metrics')).toBe(false);
    });

    it('preserves successful API startup if the metrics port is occupied', async () => {
        const reservation = await portReservation();
        vi.stubEnv('METRICS_ENABLED', 'true');
        vi.stubEnv('METRICS_HOST', '127.0.0.1');
        vi.stubEnv('METRICS_PORT', String(reservation.port));
        try {
            await expect(start()).resolves.toEqual({ port: 3005, host: '127.0.0.1' });
            expect(state.shutdown.has('metrics')).toBe(false);
        } finally {
            await reservation.close();
        }
    });
});
