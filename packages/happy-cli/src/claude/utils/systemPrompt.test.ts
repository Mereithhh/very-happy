import { describe, expect, it } from 'vitest';
import { systemPrompt } from './systemPrompt';

// B-493: 两条会改变 agent 行为的文案，2026-09-25 终端 vs Happy A/B 实测出问题。
describe('systemPrompt', () => {
    it('does not force a change_title call at the start of every chat', () => {
        expect(systemPrompt).not.toMatch(/ALWAYS when you start a new chat/);
        expect(systemPrompt).toContain('titled automatically');
        expect(systemPrompt).toContain('mcp__happy__change_title');
    });

    it('scopes Happy commit credit to commits the agent creates itself', () => {
        if (!systemPrompt.includes('via [Very Happy]')) return; // credit disabled by local settings
        expect(systemPrompt).toContain('When you yourself create a git commit');
        expect(systemPrompt).toContain('Do not add these lines to commit message text you only draft');
    });
});
