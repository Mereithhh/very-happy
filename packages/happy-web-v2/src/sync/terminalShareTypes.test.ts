import { describe, expect, it } from 'vitest';
import { IncomingTerminalShareSchema, ShareTerminalGeometrySchema, defaultTerminalShareExpiry, directlyGranted, failedRefs, planProjectOperate, readTerminalShareAck, revokeEndsAccess, serialPerKey, viewOnlyScale } from './terminalShareTypes';
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

describe('B-899 serialPerKey', () => {
    it('keeps typing order per key even when an earlier task is slower; a failure does not block the next; keys are independent', async () => {
        const run = serialPerKey();
        const out: string[] = [];
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await Promise.all([
            run('g', async () => { await wait(30); out.push('e'); }),
            run('g', async () => { out.push('c'); }),
            run('g', async () => { throw new Error('x'); }),
            run('g', async () => { await wait(5); out.push('h'); }),
            run('other', async () => { out.push('X'); }),
        ]);
        expect(out.filter((c) => c !== 'X').join('')).toBe('ech');
        expect(out.indexOf('X')).toBe(0);
    });
});


describe('B-900 planProjectOperate', () => {
    const now = 1_000_000;
    const term = (id: string, machine = 'm1') => ({ id, machineId: machine, machineName: machine === 'm1' ? 'laptop' : 'server', title: `t-${id}` });
    const grant = (terminalId: string, role: 'viewer' | 'operator', status: 'pending' | 'active' | 'revoked', grantee = 'bob', expiresAt = now + 1000, machineId = 'm1') =>
        ({ id: `g-${terminalId}-${grantee}`, machineId, terminalId, role, status, title: null, createdAt: 0, acceptedAt: null, expiresAt, grantee: { id: grantee, displayName: grantee, username: null } });

    it('skips can-operate (accepted or not), upgrades view only, creates the rest; only this person, only live grants', () => {
        const plan = planProjectOperate(
            [term('a'), term('b'), term('c'), term('d'), term('e', 'm2'), term('f')],
            [grant('a', 'operator', 'active'), grant('b', 'operator', 'pending'), grant('c', 'viewer', 'active'), grant('d', 'operator', 'active', 'carol'), grant('f', 'operator', 'active', 'bob', now - 1)],
            'bob', now);
        expect(plan.items.map((i) => [i.terminalId, i.current, i.action])).toEqual([
            ['a', 'operator', 'skip'], ['b', 'operatorPending', 'skip'], ['c', 'viewer', 'upgrade'], ['d', 'none', 'create'], ['e', 'none', 'create'], ['f', 'none', 'create'],
        ]);
        expect(plan.send.map((r) => r.terminalId)).toEqual(['c', 'd', 'e', 'f']);
        expect(plan.machines).toEqual(['laptop', 'server']);
        expect(plan.gap.map((i) => i.terminalId)).toEqual(['c', 'd', 'e', 'f']);
        expect(directlyGranted(plan).map((r) => r.terminalId)).toEqual(['a', 'b', 'c']);
    });

    it('no gap hint when the person operates none of them; nothing to send when all already operate', () => {
        expect(planProjectOperate([term('a'), term('b')], [grant('a', 'viewer', 'active')], 'bob', now).gap).toEqual([]);
        const all = planProjectOperate([term('a')], [grant('a', 'operator', 'active')], 'bob', now);
        expect(all.send).toEqual([]);
        expect(all.machines).toEqual([]);
        expect(planProjectOperate([term('a')], [grant('a', 'operator', 'revoked')], 'bob', now).items[0].action).toBe('create');
    });

    it('failedRefs: exactly the failed terminals of what was sent, for a retry', () => {
        const sent = [{ machineId: 'm1', terminalId: 'a' }, { machineId: 'm1', terminalId: 'b' }, { machineId: 'm2', terminalId: 'a' }];
        expect(failedRefs([
            { machineId: 'm1', terminalId: 'a', outcome: 'created' },
            { machineId: 'm1', terminalId: 'b', outcome: 'failed', code: 'terminal_gone' },
            { machineId: 'm2', terminalId: 'a', outcome: 'failed', code: 'relationship_rate_quota_exceeded' },
        ], sent)).toEqual([sent[1], sent[2]]);
    });
});
