import { describe, expect, it } from 'vitest';
import { createRetiredModels, retiredModelFrom } from './claudeRetiredModel';

const notFound = (extra: Record<string, unknown> = {}) => ({ type: 'assistant', error: 'model_not_found', parent_tool_use_id: null, message: { content: [] }, ...extra });

describe('retiredModelFrom (B-634 ③)', () => {
    it('names the running model when a root reply says model_not_found', () => {
        expect(retiredModelFrom(notFound(), 'claude-gone-1')).toBe('claude-gone-1');
    });

    it('ignores sub-agent replies, other errors, other frames and the default model', () => {
        expect(retiredModelFrom(notFound({ parent_tool_use_id: 'toolu_1' }), 'claude-gone-1')).toBeNull();
        expect(retiredModelFrom(notFound({ error: 'rate_limit' }), 'claude-gone-1')).toBeNull();
        expect(retiredModelFrom({ type: 'result', error: 'model_not_found' }, 'claude-gone-1')).toBeNull();
        expect(retiredModelFrom(notFound(), undefined)).toBeNull();
        expect(retiredModelFrom(notFound(), '')).toBeNull();
    });
});

describe('createRetiredModels (B-634 ③)', () => {
    it('maps a retired id to the default and leaves every other pick alone', () => {
        const retired = createRetiredModels();
        expect(retired.effective('claude-gone-1')).toBe('claude-gone-1');
        retired.retire('claude-gone-1');
        expect(retired.effective('claude-gone-1')).toBeUndefined();
        expect(retired.effective('claude-opus-5-5')).toBe('claude-opus-5-5');
        expect(retired.effective(null)).toBeUndefined();
    });
});
