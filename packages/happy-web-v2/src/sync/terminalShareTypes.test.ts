import { describe, expect, it } from 'vitest';
import { IncomingTerminalShareSchema, ShareTerminalGeometrySchema, defaultTerminalShareExpiry, readTerminalShareAck, revokeEndsAccess, viewOnlyScale } from './terminalShareTypes';
import { terminalShareEventLabelKey } from '@/screens/terminal/terminalShareEventLabels';

describe('B-878 terminal share client helpers', () => {
    it('defaults: view only 7 days, can operate 1 day (no "forever" anywhere)', () => {
        expect(defaultTerminalShareExpiry('viewer')).toBe(7);
        expect(defaultTerminalShareExpiry('operator')).toBe(1);
    });

    it('reads the broker ack; anything else is rpc_failed', () => {
        expect(readTerminalShareAck({ ok: true, result: 'abc' })).toEqual({ ok: true, result: 'abc' });
        expect(readTerminalShareAck({ ok: false, error: 'not_shared' })).toEqual({ ok: false, code: 'not_shared' });
        for (const bad of [null, 'x', { ok: true }, { ok: false }, { ok: true, result: 3 }]) expect(readTerminalShareAck(bad)).toEqual({ ok: false, code: 'rpc_failed' });
    });

    it('a view-only pane only ever shrinks to fit, never grows past natural size', () => {
        expect(viewOnlyScale(1000, 500)).toBe(0.5);
        expect(viewOnlyScale(400, 800)).toBe(1);
        expect(viewOnlyScale(0, 800)).toBe(1);
        expect(viewOnlyScale(800, 0)).toBe(1);
    });

    it('tolerates a newer server: unknown role reads as view only, extra fields are ignored', () => {
        const parsed = IncomingTerminalShareSchema.parse({ id: 'g', role: 'super', status: 'weird', granteeKey: 'k', machineId: 'm', createdAt: 1, expiresAt: 2, owner: { id: 'o', displayName: 'O' }, extra: 1 });
        expect(parsed.role).toBe('viewer');
        expect(parsed.status).toBe('pending');
        expect(ShareTerminalGeometrySchema.safeParse({ grantId: 'g', cols: 1, rows: 20 }).success).toBe(false);
    });

    it('lowering to view only keeps the page; every other end reason (and an unknown one) ends access', () => {
        expect(revokeEndsAccess('downgraded')).toBe(false);
        for (const r of ['revoked', 'expired', 'left', 'deleted', 'new-reason', undefined]) expect(revokeEndsAccess(r)).toBe(true);
    });

    it('activity log: unknown event kinds read as "other"', () => {
        expect(terminalShareEventLabelKey('terminal.attach')).toBe('share.terminal.event.attach');
        expect(terminalShareEventLabelKey('something.new')).toBe('share.terminal.event.other');
    });
});
