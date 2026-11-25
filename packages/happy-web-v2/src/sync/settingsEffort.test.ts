import { describe, expect, it } from 'vitest';
import { settingsCodexEffort } from './settingsEffort';

const entry = (code: string, reasoningEfforts?: string[]) => ({ code, value: code, ...(reasoningEfforts ? { reasoningEfforts } : {}) });
const SOL = entry('gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const G55 = entry('gpt-5.5', ['low', 'medium', 'high', 'xhigh']);
const catalog = (over: Record<string, unknown> = {}) => ({
    flavor: 'codex', path: '/w', host: 'h', machineId: 'm1', models: [SOL, G55], defaultModelCode: 'gpt-6-sol', configuredModel: 'gpt-6-sol', ...over,
}) as any;
const run = (modelMode: string, catalogs: any[], saved: string | null = null) => {
    const { levels, unsupported } = settingsCodexEffort({ modelMode, catalogs, table: null, saved });
    return { keys: levels.map((level) => level.key), unsupported };
};
const FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const BASE = ['low', 'medium', 'high', 'xhigh'];

describe('B-975b: Settings offers the Codex levels the composer does', () => {
    it.each(['default', 'latest'])('%s uses the machine config model and its reported levels', (mode) => {
        expect(run(mode, [catalog()], 'max')).toEqual({ keys: FULL, unsupported: false });
        expect(run(mode, [catalog({ configuredModel: 'gpt-5.5' })]).keys).toEqual(BASE);
    });
    it('the config model wins over the Codex default; without one the default counts', () => {
        expect(run('default', [catalog({ configuredModel: 'gpt-5.5', defaultModelCode: 'gpt-6-sol' })]).keys).toEqual(BASE);
        expect(run('default', [catalog({ configuredModel: null })]).keys).toEqual(FULL);
    });
    it('a reported catalog beats the built-in list, also for a fixed model', () => {
        expect(run('gpt-6-sol', [catalog({ models: [entry('gpt-6-sol', ['low', 'high'])] })]).keys).toEqual(['low', 'high']);
    });
    it('several machines: every level one of them runs, in order', () => {
        const other = catalog({ machineId: 'm2', configuredModel: 'x', models: [entry('x', ['minimal', 'max', 'low'])] });
        expect(run('default', [catalog({ configuredModel: 'gpt-5.5' }), other]).keys).toEqual(['minimal', ...BASE, 'max']);
    });
    it('no catalog: the fallback by model', () => {
        expect(run('default', []).keys).toEqual(BASE);
        expect(run('gpt-6-sol', []).keys).toEqual(FULL);
        expect(run('default', [catalog({ models: [entry('gpt-6-sol')] })]).keys).toEqual(FULL);
    });
    it('the saved level is always listed; unsupported only when the model is known', () => {
        expect(run('default', [], 'max')).toEqual({ keys: [...BASE, 'max'], unsupported: false });
        expect(run('latest', [], 'max')).toEqual({ keys: [...BASE, 'max'], unsupported: false });
        expect(run('gpt-5.5', [catalog()], 'max')).toEqual({ keys: [...BASE, 'max'], unsupported: true });
        expect(run('gpt-5.5', [catalog()], 'high').unsupported).toBe(false);
        expect(run('default', [catalog({ configuredModel: null, defaultModelCode: 'gpt-5.5' })], 'max').unsupported).toBe(true);
        expect(settingsCodexEffort({ modelMode: 'default', catalogs: [], table: null, saved: 'max' }).levels.at(-1)).toEqual({ key: 'max', name: 'max' });
    });
});
