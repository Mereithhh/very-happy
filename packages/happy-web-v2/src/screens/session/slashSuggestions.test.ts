import { describe, expect, it } from 'vitest';
import { filterSlashSuggestions, slashCommandText, slashQuery } from './slashSuggestions';

const items = [
    { command: 'compact' },
    { command: 'goal', description: 'Skill' },
    { command: 'deploy', description: 'Skill' },
];

describe('slashSuggestions', () => {
    it('only activates for a single slash token', () => {
        expect(slashQuery('/go')).toBe('go');
        expect(slashQuery('/')).toBe('');
        expect(slashQuery('hello /go')).toBeNull();
        expect(slashQuery('/goal now')).toBeNull();
    });

    it('ranks exact and prefix matches and preserves the slash on insertion', () => {
        expect(filterSlashSuggestions(items, '/go')).toEqual([{ command: 'goal', description: 'Skill' }]);
        expect(slashCommandText(items[1])).toBe('/goal');
    });
});
