import { describe, expect, it } from 'vitest';
import { ConnectionDiagnosticBatchSchema } from './connectionDiagnostics';
const event = {
    attemptId: 'db48f13c-29f5-49f3-8f45-5e6bc59caeaa', machineId: 'machine-1',
    at: 1000, stage: 'terminal_open', outcome: 'timeout', durationMs: 3000,
    deviceClass: 'mobile', visibility: 'visible', client: 'web/78086a260',
};
describe('connection diagnostic wire boundary', () => {
    it('accepts bounded batches and a control event without a machine', () => {
        expect(ConnectionDiagnosticBatchSchema.safeParse({ events: [event] }).success).toBe(true);
        expect(ConnectionDiagnosticBatchSchema.safeParse({ events: [{ ...event, machineId: undefined, stage: 'control', client: 'web/unknown' }] }).success).toBe(true);
    });
    it.each([
        { ...event, message: 'private terminal content' }, { ...event, stage: 'arbitrary-text' },
        { ...event, client: 'web/private@example.com' }, { ...event, attemptId: 'not-a-uuid' },
        { ...event, machineId: 'private@example.com' }, { ...event, durationMs: 300001 },
        { ...event, at: Infinity },
    ])('rejects unbounded or noncategorical records %#', (invalid) => {
        expect(ConnectionDiagnosticBatchSchema.safeParse({ events: [invalid] }).success).toBe(false);
    });
    it('rejects empty, oversized batches and unknown top-level keys', () => {
        for (const value of [{ events: [] }, { events: Array(33).fill(event) }, { events: [event], token: 'secret' }]) {
            expect(ConnectionDiagnosticBatchSchema.safeParse(value).success).toBe(false);
        }
    });
});
