import { describe, expect, it } from 'vitest';
import { decideUpdate } from './updatePromptPolicy';

describe('decideUpdate', () => {
    it('asks whenever someone is looking at the tab', () => {
        // The reported bug was the surprise itself, so there is no idle-page
        // exemption: a visible tab is always asked.
        expect(decideUpdate({ hidden: false })).toEqual({ action: 'prompt' });
    });

    it('applies itself once the tab is hidden, so an ignored prompt is not forever', () => {
        expect(decideUpdate({ hidden: true })).toEqual({ action: 'apply' });
    });
});
