import { describe, expect, it, vi } from 'vitest';
import { VERY_HAPPY_DISCOVERY } from '@/skill/discovery';

describe('Claude Very Happy / Todo skill discovery (B-575 → B-917)', () => {
    it.each([true, false])('is present exactly once with coauthor setting %s', async (includeCredits) => {
        vi.resetModules();
        vi.doMock('./claudeSettings', () => ({ shouldIncludeCoAuthoredBy: () => includeCredits }));
        const { systemPrompt } = await import('./systemPrompt');
        expect(systemPrompt.split(VERY_HAPPY_DISCOVERY)).toHaveLength(2);
        // Todo discovery must survive the merge into the general line.
        expect(systemPrompt).toContain('very-happy todo skill');
        expect(systemPrompt).toContain('very-happy skill');
        expect(systemPrompt).toContain('restricted team workers must not bypass their scope');
        vi.doUnmock('./claudeSettings');
    });
});
