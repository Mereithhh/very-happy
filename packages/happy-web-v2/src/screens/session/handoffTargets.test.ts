// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Machine, Session } from '@/sync/storageTypes';
import { handoffCandidates } from './handoffTargets';

const s = (id: string, extra: Partial<Session> & { title?: string; flavor?: string; machineId?: string; path?: string } = {}): Session => ({
    id, active: false, activeAt: 0, updatedAt: 0, archivedAt: null,
    metadata: { path: extra.path ?? `/w/${id}`, host: 'h', machineId: extra.machineId ?? 'm1', flavor: extra.flavor ?? 'claude', summary: { text: extra.title ?? id, updatedAt: 0 } },
    ...extra,
} as unknown as Session);
const machines = { m1: { id: 'm1', active: true, metadata: { displayName: 'dev-box', host: 'h' } } as unknown as Machine };

describe('handoff targets (B-915)', () => {
    it('excludes self, archived, shared-with-me and terminal mirrors; live first, then most recent', () => {
        const list = handoffCandidates([
            s('self'), s('old', { activeAt: 10 }), s('live', { active: true, activeAt: 1 }), s('recent', { activeAt: 50 }),
            s('arch', { archivedAt: 3 }), s('shared', { share: {} as never }), s('mirror', { flavor: 'terminal-mirror' }),
        ], machines, 'self', '');
        expect(list.map((c) => c.id)).toEqual(['live', 'recent', 'old']);
        expect(list[0]).toMatchObject({ online: true, machineName: 'dev-box', machineId: 'm1' });
    });
    it('search matches title, machine, path and an id prefix', () => {
        const all = [s('a1', { title: 'GPU view' }), s('b2', { title: 'Weekly', path: '/repo/reports' }), s('c3', { title: 'Other', machineId: 'mx' })];
        expect(handoffCandidates(all, machines, 'x', 'gpu').map((c) => c.id)).toEqual(['a1']);
        expect(handoffCandidates(all, machines, 'x', 'reports').map((c) => c.id)).toEqual(['b2']);
        expect(handoffCandidates(all, machines, 'x', 'dev-box').map((c) => c.id).sort()).toEqual(['a1', 'b2']);
        expect(handoffCandidates(all, machines, 'x', 'c3').map((c) => c.id)).toEqual(['c3']);
    });
});
