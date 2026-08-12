import { describe, it, expect } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import { decideQuickChat, pushRecentMachinePath, type RecentMachinePath } from './quickChat';

const M = (id: string, active: boolean): Machine => ({
    id,
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active,
    activeAt: 0,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
});

const R = (machineId: string, path: string): RecentMachinePath => ({ machineId, path });

describe('decideQuickChat', () => {
    it('always-ask on → configure, even when everything else would resolve', () => {
        expect(
            decideQuickChat({ machines: [M('a', true)], recents: [R('a', '/w')], alwaysAsk: true }),
        ).toEqual({ kind: 'configure' });
    });

    it('no machines / none online → configure (dialog shows its empty state)', () => {
        expect(decideQuickChat({ machines: [], recents: [], alwaysAsk: false })).toEqual({ kind: 'configure' });
        expect(
            decideQuickChat({ machines: [M('a', false)], recents: [R('a', '/w')], alwaysAsk: false }),
        ).toEqual({ kind: 'configure' });
    });

    it('sole online machine + remembered path for it → spawn there', () => {
        expect(
            decideQuickChat({
                machines: [M('a', false), M('b', true)],
                recents: [R('a', '/other'), R('b', '/work')],
                alwaysAsk: false,
            }),
        ).toEqual({ kind: 'spawn', machineId: 'b', directory: '/work' });
    });

    it('sole online machine but no remembered path for THAT machine → configure once', () => {
        expect(
            decideQuickChat({
                machines: [M('b', true)],
                recents: [R('a', '/other')],
                alwaysAsk: false,
            }),
        ).toEqual({ kind: 'configure' });
    });

    it('several online → most recent entry whose machine is online wins (offline entries skipped)', () => {
        expect(
            decideQuickChat({
                machines: [M('a', true), M('b', true), M('c', false)],
                recents: [R('c', '/gone'), R('b', '/beta'), R('a', '/alpha')],
                alwaysAsk: false,
            }),
        ).toEqual({ kind: 'spawn', machineId: 'b', directory: '/beta' });
    });

    it('several online, nothing remembered → configure (machine ambiguous)', () => {
        expect(
            decideQuickChat({ machines: [M('a', true), M('b', true)], recents: [], alwaysAsk: false }),
        ).toEqual({ kind: 'configure' });
    });

    it('directory = the most recent path for the chosen machine, not just recents[0]', () => {
        expect(
            decideQuickChat({
                machines: [M('a', true)],
                recents: [R('x', '/newest-but-other-machine'), R('a', '/second'), R('a', '/older')],
                alwaysAsk: false,
            }),
        ).toEqual({ kind: 'spawn', machineId: 'a', directory: '/second' });
    });
});

describe('pushRecentMachinePath', () => {
    it('prepends a new entry', () => {
        expect(pushRecentMachinePath([R('a', '/1')], R('b', '/2'))).toEqual([R('b', '/2'), R('a', '/1')]);
    });

    it('moves an existing identical entry to the front instead of duplicating', () => {
        expect(pushRecentMachinePath([R('a', '/1'), R('b', '/2')], R('b', '/2'))).toEqual([
            R('b', '/2'),
            R('a', '/1'),
        ]);
    });

    it('same machine, different path → both kept (per-machine history)', () => {
        expect(pushRecentMachinePath([R('a', '/1')], R('a', '/2'))).toEqual([R('a', '/2'), R('a', '/1')]);
    });

    it('caps the list at 10 most recent', () => {
        const list = Array.from({ length: 10 }, (_, i) => R('m', `/p${i}`));
        const next = pushRecentMachinePath(list, R('m', '/new'));
        expect(next).toHaveLength(10);
        expect(next[0]).toEqual(R('m', '/new'));
        expect(next.at(-1)).toEqual(R('m', '/p8'));
    });
});
