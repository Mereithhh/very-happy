import { describe, expect, it } from 'vitest';
import type { Metadata } from './storageTypes';
import { forkCatalogSource } from './launcherModels';

const catalog = [{ code: 'sonnet', value: 'Sonnet 5.5', description: null }] as unknown as Metadata['models'];
const meta = (over: Partial<Metadata>) => ({ flavor: 'claude', machineId: 'm', ...over }) as Metadata;

describe('B-851 forkCatalogSource', () => {
    it('a fork borrows its parent’s catalog until its own wrapper publishes one', () => {
        const parent = meta({ models: catalog });
        expect(forkCatalogSource(meta({ parentSessionId: 'p' }), parent)).toBe(parent);
        const own = meta({ models: [{ code: 'haiku', value: 'Haiku 5.5', description: null }] as never });
        expect(forkCatalogSource(own, parent)).toBe(own);
    });
    it('never borrows across agents or machines, or from a parent without a catalog', () => {
        const child = meta({});
        expect(forkCatalogSource(child, meta({ models: catalog, flavor: 'codex' }))).toBe(child);
        expect(forkCatalogSource(child, meta({ models: catalog, machineId: 'other' }))).toBe(child);
        expect(forkCatalogSource(child, meta({}))).toBe(child);
        expect(forkCatalogSource(child, null)).toBe(child);
        expect(forkCatalogSource(null, meta({ models: catalog }))).toBeNull();
    });
});
