import { describe, expect, it } from 'vitest';
import {
    CODEX_CONTEXT_DEFAULT_MODE,
    codexContextThreadConfig,
    codexContextWindowsOf,
    parseCodexModelWindows,
    readCodexContextMode,
    readCodexContextWindows,
} from './codexContext';

describe('B-977 Codex context modes', () => {
    it('defaults to standard (pending Owner decision: change only the constant)', () => {
        expect(CODEX_CONTEXT_DEFAULT_MODE).toBe('standard');
    });

    it('reads only the two modes', () => {
        expect(readCodexContextMode('standard')).toBe('standard');
        expect(readCodexContextMode('extended')).toBe('extended');
        for (const raw of ['1m', '', null, undefined, 1, {}]) expect(readCodexContextMode(raw)).toBeNull();
    });

    it('effective windows match what Codex 0.171 reports (catalog × 95%)', () => {
        expect(codexContextWindowsOf({ window: 272000, maxWindow: 872000, effectivePercent: 95 })).toEqual({ standard: 258400, extended: 828400 });
        expect(codexContextWindowsOf({ window: 500000, maxWindow: 872000, effectivePercent: 95 })).toEqual({ standard: 475000, extended: 828400 });
        expect(codexContextWindowsOf({ window: 272000, maxWindow: 272000, effectivePercent: 95 })).toBeNull();
        expect(codexContextWindowsOf(null)).toBeNull();
    });

    it('extended = catalog maximum, standard = catalog window (Codex default, said explicitly), both compact at 90%; non-extendable sends nothing', () => {
        const astra = { window: 272000, maxWindow: 872000, effectivePercent: 95 };
        expect(codexContextThreadConfig('extended', astra)).toEqual({ model_context_window: 872000, model_auto_compact_token_limit: 784800 });
        expect(codexContextThreadConfig('standard', astra)).toEqual({ model_context_window: 272000, model_auto_compact_token_limit: 244800 });
        expect(codexContextThreadConfig('standard', { window: 500000, maxWindow: 872000, effectivePercent: 95 })).toEqual({ model_context_window: 500000, model_auto_compact_token_limit: 450000 });
        expect(codexContextThreadConfig('extended', { window: 272000, maxWindow: 272000, effectivePercent: 95 })).toEqual({});
        expect(codexContextThreadConfig('extended', undefined)).toEqual({});
    });

    it('parses the catalog dump; a missing max means no extension, a bad percent means 100', () => {
        const windows = parseCodexModelWindows({ models: [
            { slug: 'a', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
            { slug: 'b', context_window: 272000 },
            { slug: 'c', context_window: 272000, max_context_window: 100, effective_context_window_percent: 500 },
            { slug: 'd' }, null, 'x',
        ] });
        expect(windows.get('a')).toEqual({ window: 272000, maxWindow: 872000, effectivePercent: 95 });
        expect(windows.get('b')).toEqual({ window: 272000, maxWindow: 272000, effectivePercent: 100 });
        expect(windows.get('c')).toEqual({ window: 272000, maxWindow: 272000, effectivePercent: 100 });
        expect(windows.has('d')).toBe(false);
        expect(parseCodexModelWindows(null).size).toBe(0);
    });

    it('reads published windows, dropping malformed entries', () => {
        expect(readCodexContextWindows({
            'gpt-6.2-sol': { standard: 475000, extended: 828400 },
            bad: { standard: 'x', extended: 1 },
            shrunk: { standard: 500, extended: 400 },
        })).toEqual({ 'gpt-6.2-sol': { standard: 475000, extended: 828400 } });
        expect(readCodexContextWindows([1])).toEqual({});
        expect(readCodexContextWindows(null)).toEqual({});
    });
});
