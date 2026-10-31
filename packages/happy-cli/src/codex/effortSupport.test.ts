import { describe, expect, it } from 'vitest';
import { settleTurnEffort, unsupportedEffortReason } from './effortSupport';

const catalog = [
    { model: 'gpt-6-astra', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({ reasoningEffort })) },
    { model: 'gpt-5.5', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })) },
];

describe('unsupportedEffortReason', () => {
    it('judges catalog models by their advertised levels', () => {
        expect(unsupportedEffortReason(catalog, 'gpt-5.5', 'ultra')).toMatch(/not supported by gpt-5.5/);
        expect(unsupportedEffortReason(catalog, 'gpt-5.5', 'xhigh')).toBeNull();
        expect(unsupportedEffortReason(catalog, undefined, 'ultra')).toBeNull();
    });

    it('leaves models missing from the catalog to Codex (gpt-6-sol at ultra ran end to end)', () => {
        expect(unsupportedEffortReason(catalog, 'gpt-6-sol', 'ultra')).toBeNull();
        expect(unsupportedEffortReason([], undefined, 'ultra')).toBeNull();
    });

    it('never blocks an unset effort', () => {
        expect(unsupportedEffortReason(catalog, 'gpt-5.5', undefined)).toBeNull();
    });
});

describe('settleTurnEffort (B-849b2, QA28 P2-4)', () => {
    it('a supported level runs as is', () => {
        expect(settleTurnEffort(catalog, 'gpt-6-astra', 'xhigh', { explicit: true, fallback: 'medium' })).toEqual({ refusal: null, effort: 'xhigh', changed: false });
    });
    it('a level the message named is refused, and the held level rolls back to the last started one', () => {
        const settled = settleTurnEffort(catalog, 'gpt-6-astra', 'minimal', { explicit: true, fallback: 'xhigh' });
        expect(settled.refusal).toMatch(/"minimal" is not supported by gpt-6-astra/);
        expect(settled).toMatchObject({ effort: 'xhigh', changed: true });
    });
    it('a held (sticky / restored) refused level is no choice: the turn runs on the fallback', () => {
        expect(settleTurnEffort(catalog, 'gpt-6-astra', 'minimal', { explicit: false, fallback: 'high' })).toEqual({ refusal: null, effort: 'high', changed: true });
    });
    it('a fallback the model refuses too settles on the catalog default level, else none', () => {
        expect(settleTurnEffort(catalog, 'gpt-6-astra', 'minimal', { explicit: false, fallback: 'minimal' })).toEqual({ refusal: null, effort: undefined, changed: true });
        const withDefault = [{ ...catalog[0], defaultReasoningEffort: 'medium' as const }];
        expect(settleTurnEffort(withDefault, 'gpt-6-astra', 'minimal', { explicit: false, fallback: 'minimal' })).toEqual({ refusal: null, effort: 'medium', changed: true });
    });
});
