import { describe, expect, it } from 'vitest';
import { unsupportedEffortReason } from './effortSupport';

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
