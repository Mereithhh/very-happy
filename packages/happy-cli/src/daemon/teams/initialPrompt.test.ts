import { describe, expect, it } from 'vitest';
import { teamInitialPrompt } from './initialPrompt';
import { TEAM_SKILL } from '@/teams/resources';

describe('managed team entry instructions', () => {
    it('includes the bundled skill and lead authority without inventing goal completion', () => {
        const prompt = teamInitialPrompt('Build a dashboard', true, '/isolated/lead');
        expect(prompt).toContain(TEAM_SKILL);
        expect(prompt).toContain('/isolated/lead');
        expect(prompt).toContain('You are the team lead');
        expect(prompt).toContain('must not accept your own root goal');
        expect(prompt).toContain('Build a dashboard');
    });
    it('keeps delegated authority scoped to the assigned worktree and task', () => {
        const prompt = teamInitialPrompt('Check tests', false);
        expect(prompt).toContain('You are a team member');
        expect(prompt).toContain('assigned worktree');
        expect(prompt).not.toContain('You are the team lead');
    });
});
