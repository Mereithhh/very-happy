import { describe, expect, it } from 'vitest';
import { compactResolvedModelCode, relabelDefaultModel } from './modelModeOptions';

describe('resolved default model labels', () => {
    it('keeps the concrete model value while removing the redundant Claude prefix', () => {
        expect(compactResolvedModelCode('claude-opus-5[1m]')).toBe('opus-5[1m]');
        expect(compactResolvedModelCode('gpt-5.5')).toBe('gpt-5.5');
    });

    it('only relabels the default option', () => {
        expect(relabelDefaultModel([
            { key: 'default', name: 'default model' },
            { key: 'opus', name: 'opus 5' },
        ], 'opus-5 (default)')).toEqual([
            { key: 'default', name: 'opus-5 (default)' },
            { key: 'opus', name: 'opus 5' },
        ]);
    });
});
