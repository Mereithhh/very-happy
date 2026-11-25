import { describe, expect, it } from 'vitest';
import { PI_THINKING_LEVELS, piCatalogFromMachine, piDraftThoughtLevels, readPiModelTable } from './piModelTable';

const daemonState = (over: Record<string, unknown> = {}) => ({
    pid: 42,
    piModels: {
        checkedAt: 1_000,
        daemonPid: 42,
        models: [
            { code: 'fakehub/fake-large', value: 'fakehub/fake-large', thinking: true },
            { code: 'fakehub/fake-small', value: 'fakehub/fake-small', thinking: false },
        ],
    },
    ...over,
});

describe('readPiModelTable (B-978)', () => {
    it('reads this daemon run’s table', () => {
        const table = readPiModelTable(daemonState(), 1_100);
        expect(table?.models.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
    });

    it('ignores another daemon run, an old snapshot and malformed entries', () => {
        expect(readPiModelTable(daemonState({ pid: 7 }), 1_100)).toBeNull();
        expect(readPiModelTable(daemonState(), 1_000 + 13 * 60 * 60 * 1000)).toBeNull();
        expect(readPiModelTable({ pid: 42 }, 1_100)).toBeNull();
        expect(readPiModelTable(daemonState({ piModels: { checkedAt: 1_000, daemonPid: 42, models: [{ code: 1 }] } }), 1_100)).toBeNull();
    });

    it('an old daemon that never writes the field reads as null, so only default shows', () => {
        expect(readPiModelTable({ pid: 42, agentVersions: {} }, 1_100)).toBeNull();
        expect(readPiModelTable(null, 1_100)).toBeNull();
    });
});

describe('piCatalogFromMachine / piDraftThoughtLevels (B-978)', () => {
    const table = readPiModelTable(daemonState(), 1_100);

    it('shapes a launcher catalog with the machine models', () => {
        const catalog = piCatalogFromMachine(table, 'pi');
        expect(catalog?.models?.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
        expect(catalog?.thoughtLevels).toHaveLength(PI_THINKING_LEVELS.length);
    });

    it('offers thinking levels only for a thinking-capable model', () => {
        expect(piDraftThoughtLevels(table, 'fakehub/fake-large').map((l) => l.code)).toEqual([...PI_THINKING_LEVELS]);
        expect(piDraftThoughtLevels(table, 'fakehub/fake-small')).toEqual([]);
        expect(piDraftThoughtLevels(null, 'fakehub/fake-large')).toEqual([]);
    });
});
