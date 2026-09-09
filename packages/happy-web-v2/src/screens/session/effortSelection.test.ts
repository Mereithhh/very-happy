import { expect, it } from 'vitest';
import { selectDisplayedEffortKey } from './effortSelection';
const options = ['low', 'medium', 'high'].map((key) => ({ key, name: key }));
it('keeps supported intent ahead of current backend effort', () => {
    expect(selectDisplayedEffortKey(options, ['high', 'low'])).toBe('high');
});
it('falls back to backend confirmation after model invalidates stored effort', () => {
    expect(selectDisplayedEffortKey(options, ['ultra', 'medium'])).toBe('medium');
});
it('does not invent the first option when nothing is confirmed', () => {
    expect(selectDisplayedEffortKey(options, ['ultra', undefined])).toBeNull();
});
