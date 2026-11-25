import { describe, expect, it } from 'vitest';
import { codexContextOptions, contextWindowsForModel, formatContextWindow, resolveCodexContextMode, settingsCodexContextOptions, supportsCodexContextChoice } from './codexContextMode';

const codex = {
    flavor: 'codex',
    currentModelCode: 'gpt-6.2-astra',
    codexContextMode: 'standard',
    codexContextWindows: {
        'gpt-6.2-astra': { standard: 258400, extended: 828400 },
        'gpt-6.2-sol': { standard: 475000, extended: 828400 },
    },
};

describe('B-977 web codex context mode', () => {
    it('offers both windows only for a Codex model the wrapper reports as extendable', () => {
        expect(supportsCodexContextChoice(codex, 'gpt-6.2-astra')).toBe(true);
        expect(codexContextOptions(codex, 'gpt-6.2-astra')).toEqual([
            { key: 'standard', window: 258400 },
            { key: 'extended', window: 828400 },
        ]);
        // A model outside the report, a non-Codex agent, an older wrapper: no picker.
        expect(codexContextOptions(codex, 'gpt-5.5')).toBeNull();
        expect(codexContextOptions({ ...codex, flavor: 'claude' }, 'gpt-6.2-astra')).toBeNull();
        expect(codexContextOptions({ flavor: 'codex', currentModelCode: 'gpt-6.2-astra' }, 'gpt-6.2-astra')).toBeNull();
        expect(contextWindowsForModel(codex, null)).toBeNull();
    });

    it('the wrapper report wins over a local pick, which wins over the account default', () => {
        expect(resolveCodexContextMode(codex, 'extended', undefined)).toBe('standard');
        expect(resolveCodexContextMode({ ...codex, codexContextMode: undefined }, 'extended', 'standard')).toBe('extended');
        expect(resolveCodexContextMode({ ...codex, codexContextMode: 'extended' }, 'standard', undefined)).toBe('extended');
        // Nothing said anywhere: the product default.
        expect(resolveCodexContextMode({ flavor: 'codex' }, null, null)).toBe('standard');
        expect(resolveCodexContextMode(codex, 'bogus', 'bogus')).toBe('standard');
    });

    it('labels carry the real window (never "1M")', () => {
        expect(formatContextWindow(258400)).toBe('25.8 万');
        expect(formatContextWindow(475000)).toBe('47.5 万');
        expect(formatContextWindow(828400)).toBe('82.8 万');
        expect(formatContextWindow(1000000)).toBe('100 万');
    });

    it('Settings offers the row only for a model some machine reports as extendable', () => {
        const catalogs = [{ ...codex, configuredModel: 'gpt-6.2-sol', defaultModelCode: 'gpt-6.2-sol' }, { flavor: 'codex', configuredModel: 'gpt-5.5' }];
        expect(settingsCodexContextOptions({ modelMode: 'default', catalogs })?.model).toBe('gpt-6.2-sol');
        expect(settingsCodexContextOptions({ modelMode: 'gpt-6.2-astra', catalogs })?.options.map((o) => o.key)).toEqual(['standard', 'extended']);
        expect(settingsCodexContextOptions({ modelMode: 'default', catalogs: [catalogs[1]] })).toBeNull();
        expect(settingsCodexContextOptions({ modelMode: 'default', catalogs: [] })).toBeNull();
    });
});

describe('B-977 default extended (Owner 11-26, #171)', () => {
    const fresh = { flavor: 'codex', currentModelCode: 'gpt-6.2-astra', codexContextWindows: codex.codexContextWindows };
    it('a new session with no report, pick or account default runs extended on an extendable model', () => {
        expect(resolveCodexContextMode(fresh, null, null)).toBe('extended');
    });
    it('the account default set in Settings overrides the global default, a session pick overrides both', () => {
        expect(resolveCodexContextMode(fresh, null, 'standard')).toBe('standard');
        expect(resolveCodexContextMode(fresh, 'standard', 'extended')).toBe('standard');
    });
    it('no catalog (older CLI, machine without windows) falls back to standard without error', () => {
        expect(resolveCodexContextMode({ flavor: 'codex', currentModelCode: 'gpt-5.5' }, null, null)).toBe('standard');
        expect(resolveCodexContextMode(undefined, null, 'extended')).toBe('standard');
    });
    it('an existing session keeps the level the wrapper reported', () => {
        expect(resolveCodexContextMode({ ...fresh, codexContextMode: 'standard' }, null, 'extended')).toBe('standard');
    });
});
