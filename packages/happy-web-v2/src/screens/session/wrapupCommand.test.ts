import { describe, expect, it } from 'vitest';
import { builtinActionSuggestions, canOfferBuiltinActions, parseBuiltinActionCommand } from './wrapupCommand';
import { filterSlashSuggestions } from './slashSuggestions';

const desc = { wrapup: 'W', handoff: 'H' };

describe('B-915 composer commands', () => {
    it('only the whole command is a built-in action', () => {
        expect(parseBuiltinActionCommand('/wrapup')).toBe('wrapup');
        expect(parseBuiltinActionCommand('  /WrapUp ')).toBe('wrapup');
        expect(parseBuiltinActionCommand('/收尾')).toBe('wrapup');
        expect(parseBuiltinActionCommand('/handoff')).toBe('handoff');
        expect(parseBuiltinActionCommand('/交接')).toBe('handoff');
        expect(parseBuiltinActionCommand('/wrapupx')).toBeNull();
        expect(parseBuiltinActionCommand('/wrapup now')).toBeNull();
        expect(parseBuiltinActionCommand('please /wrapup')).toBeNull();
    });
    it('suggestions: English names on `/`, the Chinese spellings once a CJK query is typed', () => {
        expect(filterSlashSuggestions(builtinActionSuggestions('/', desc), '/').map((i) => i.command)).toEqual(['wrapup', 'handoff']);
        expect(filterSlashSuggestions(builtinActionSuggestions('/wr', desc), '/wr').map((i) => i.command)).toEqual(['wrapup']);
        expect(filterSlashSuggestions(builtinActionSuggestions('/收', desc), '/收').map((i) => i.command)).toEqual(['收尾']);
        expect(filterSlashSuggestions(builtinActionSuggestions('/交', desc), '/交').map((i) => i.command)).toEqual(['交接']);
    });
    it('offered only on my own live agent sessions', () => {
        expect(canOfferBuiltinActions({ archivedAt: null, metadata: { flavor: 'claude' } })).toBe(true);
        expect(canOfferBuiltinActions({ archivedAt: 5, metadata: { flavor: 'claude' } })).toBe(false);
        expect(canOfferBuiltinActions({ share: {}, archivedAt: null })).toBe(false);
        expect(canOfferBuiltinActions({ archivedAt: null, metadata: { flavor: 'terminal-mirror' } })).toBe(false);
        expect(canOfferBuiltinActions(undefined)).toBe(false);
    });
});
