import { describe, expect, it } from 'vitest';
import { PI_THINKING_LEVELS, isPartialPiCatalog, piCatalogFromMachine, piDraftThoughtLevels, readPiModelTable } from './piModelTable';

const daemonState = (over: Record<string, unknown> = {}, table: Record<string, unknown> = {}) => ({
    pid: 42,
    piModels: {
        checkedAt: 1_000,
        daemonPid: 42,
        source: 'cli',
        models: [
            { code: 'fakehub/fake-large', value: 'fakehub/fake-large', thinking: true },
            { code: 'fakehub/fake-small', value: 'fakehub/fake-small', thinking: false },
        ],
        ...table,
    },
    ...over,
});

describe('readPiModelTable (B-978)', () => {
    it('reads this daemon run’s table and its source', () => {
        const table = readPiModelTable(daemonState(), 1_100);
        expect(table?.models.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
        expect(table?.source).toBe('cli');
        expect(readPiModelTable(daemonState({}, { source: 'models-json' }), 1_100)?.source).toBe('models-json');
    });

    it('ignores another daemon run, an old snapshot and malformed entries', () => {
        expect(readPiModelTable(daemonState({ pid: 7 }), 1_100)).toBeNull();
        expect(readPiModelTable(daemonState(), 1_000 + 13 * 60 * 60 * 1000)).toBeNull();
        expect(readPiModelTable({ pid: 42 }, 1_100)).toBeNull();
        expect(readPiModelTable(daemonState({}, { models: [{ code: 1 }] }), 1_100)).toBeNull();
    });

    it('an old daemon that never writes the field reads as null, so only default shows', () => {
        expect(readPiModelTable({ pid: 42, agentVersions: {} }, 1_100)).toBeNull();
        expect(readPiModelTable(null, 1_100)).toBeNull();
    });
});

describe('piCatalogFromMachine / piDraftThoughtLevels / isPartialPiCatalog (B-978)', () => {
    const table = readPiModelTable(daemonState(), 1_100);
    const catalog = piCatalogFromMachine(table, 'pi', 'm1');

    it('shapes a launcher catalog with the machine models and its machine id', () => {
        expect(catalog?.models?.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
        expect(catalog?.machineId).toBe('m1');
    });

    it('offers thinking levels only for a model the machine reported as reasoning', () => {
        expect(piDraftThoughtLevels(catalog, 'fakehub/fake-large').map((l) => l.code)).toEqual([...PI_THINKING_LEVELS]);
        expect(piDraftThoughtLevels(catalog, 'fakehub/fake-small')).toEqual([]);
    });

    it('shows only 「默认」 when the model is unknown: default, a session catalog, or no catalog', () => {
        expect(piDraftThoughtLevels(catalog, 'default')).toEqual([]);
        expect(piDraftThoughtLevels({ models: [{ code: 'fakehub/fake-large', value: 'x' }] }, 'fakehub/fake-large')).toEqual([]);
        expect(piDraftThoughtLevels(null, 'fakehub/fake-large')).toEqual([]);
    });

    it('marks a models.json list as partial', () => {
        expect(isPartialPiCatalog(catalog)).toBe(false);
        expect(isPartialPiCatalog(piCatalogFromMachine(readPiModelTable(daemonState({}, { source: 'models-json' }), 1_100), 'pi'))).toBe(true);
        expect(isPartialPiCatalog(null)).toBe(false);
    });
});
