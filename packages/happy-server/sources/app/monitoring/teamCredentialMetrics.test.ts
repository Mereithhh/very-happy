import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({ dbMock: { $queryRaw: vi.fn() } }));
vi.mock('@/storage/db', () => ({ db: dbMock }));

import { register } from 'prom-client';
import { updateTeamCredentialMetrics } from './metrics2';

/** B-944: the gauge behind VeryHappyTeamRootCredentialExpiring / ...Expired. */
describe('team root credential metrics', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('publishes expiring and expired counts as labelled gauge values', async () => {
        dbMock.$queryRaw.mockResolvedValue([{ expiring: 2n, expired: 1n }]);
        await updateTeamCredentialMetrics();
        const metric = (await register.getMetricsAsJSON()).find(m => m.name === 'team_root_credentials')!;
        const values = Object.fromEntries((metric.values as { labels: { state: string }; value: number }[]).map(v => [v.labels.state, v.value]));
        expect(values).toMatchObject({ expiring: 2, expired: 1 });
    });

    it('reports zero when no row matches', async () => {
        dbMock.$queryRaw.mockResolvedValue([]);
        await updateTeamCredentialMetrics();
        const metric = (await register.getMetricsAsJSON()).find(m => m.name === 'team_root_credentials')!;
        expect((metric.values as { value: number }[]).every(v => v.value === 0)).toBe(true);
    });
});
