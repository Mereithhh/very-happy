import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_TODO_DISCOVERY } from '@/modules/todo/skill';

describe('Claude Todo skill discovery', () => {
    it.each([true, false])('is present exactly once with coauthor setting %s', async (includeCredits) => {
        vi.resetModules();
        vi.doMock('./claudeSettings', () => ({ shouldIncludeCoAuthoredBy: () => includeCredits }));
        const { systemPrompt } = await import('./systemPrompt');
        expect(systemPrompt.split(BUILTIN_TODO_DISCOVERY)).toHaveLength(2);
        expect(systemPrompt).toContain('very-happy todo skill');
        expect(systemPrompt).toContain('restricted team workers must not bypass their scope');
        vi.doUnmock('./claudeSettings');
    });
});
