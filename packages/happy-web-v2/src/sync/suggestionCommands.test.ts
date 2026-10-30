import { describe, expect, it } from 'vitest';
import { buildCommandItems } from './suggestionCommandItems';

describe('buildCommandItems', () => {
    it('includes Claude macros and skills, normalizes slashes, and deduplicates them', () => {
        const items = buildCommandItems(['/review', 'custom'], ['/goal', 'goal', '  /deploy  ']);
        expect(items.map((item) => item.command)).toEqual([
            'compact', 'clear', 'mcp', 'skills', 'custom', 'goal', 'deploy',
        ]);
        expect(items.find((item) => item.command === 'goal')?.description).toBe('Skill');
    });

    it('drops blank and ignored commands after normalization', () => {
        const items = buildCommandItems(['', ' /help'], ['///logout', '   ']);
        expect(items.map((item) => item.command)).toEqual(['compact', 'clear', 'mcp', 'skills']);
    });

    it('keeps /compact listed but marks it unavailable where the session cannot compact', () => {
        expect(buildCommandItems([], [], { compactUnavailable: true }).find((item) => item.command === 'compact')?.unavailable).toBe(true);
        expect(buildCommandItems([], []).find((item) => item.command === 'compact')?.unavailable).toBeUndefined();
    });
});
