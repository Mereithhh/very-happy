import { describe, expect, it } from 'vitest';
import { teamInitialPrompt } from './initialPrompt';
import { TEAM_LEAD_PLAYBOOK, TEAM_MEMBER_RULES, TEAM_SKILL } from '@/teams/resources';
import { TEAM_TOOL_NAMES } from '@/teams/tools';
import { PROJECT_TOOL_NAMES } from '@/projects/tools';

/** Every tool the injected text names must be a tool the session really has. */
function namedTools(text: string): string[] {
    const happy = [...text.matchAll(/mcp__happy__([a-z_]+)/g)].map(m => m[1]);
    const bare = [...text.matchAll(/\b((?:team|project)_[a-z_]+)\b/g)].map(m => m[1]);
    return [...new Set([...happy, ...bare])];
}

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

    // B-725: the lead gets the working method by default; members get only their rules.
    it('gives the lead the seven-rule playbook, and members the member rules only', () => {
        const lead = teamInitialPrompt('g', true);
        const member = teamInitialPrompt('g', false);
        expect(lead).toContain(TEAM_LEAD_PLAYBOOK);
        expect(lead).not.toContain(TEAM_MEMBER_RULES);
        expect(member).toContain(TEAM_MEMBER_RULES);
        expect(member).not.toContain(TEAM_LEAD_PLAYBOOK);
        const rules = TEAM_LEAD_PLAYBOOK.split('\n').filter(line => /^\d+\. /.test(line)).map(line => line.split('.')[1].trim());
        expect(rules).toEqual(['Delegate first', 'Run work in parallel', 'Prevent conflicts', 'Keep the team context', 'Write complete task briefs', 'Review before accepting', 'Communicate briefly']);
        expect(TEAM_LEAD_PLAYBOOK).toContain('Do not write code yourself');
        expect(TEAM_LEAD_PLAYBOOK).toContain('link this team to a project');
        expect(TEAM_LEAD_PLAYBOOK).toContain('recipientBotId');
        expect(TEAM_MEMBER_RULES).toContain('Do only what your task asks');
        expect(TEAM_MEMBER_RULES).toMatch(/overlaps another member's or needs a wider scope, tell your lead/);
        // Short by design: it rides in front of every lead's first turn.
        expect(TEAM_LEAD_PLAYBOOK.split('\n').length).toBeLessThanOrEqual(40);
        expect(TEAM_LEAD_PLAYBOOK.length).toBeLessThanOrEqual(3200);
    });
    it('names only tools that exist, and the project tools that hold the team context', () => {
        const known = new Set<string>([...TEAM_TOOL_NAMES, ...PROJECT_TOOL_NAMES]);
        for (const text of [TEAM_SKILL, TEAM_LEAD_PLAYBOOK, TEAM_MEMBER_RULES]) {
            for (const name of namedTools(text)) expect(known, `${name} is not a registered tool`).toContain(name);
        }
        expect(namedTools(TEAM_LEAD_PLAYBOOK)).toEqual(expect.arrayContaining(['project_note', 'project_context', 'team_accept', 'team_return', 'team_message', 'team_inspect']));
        expect(namedTools(TEAM_MEMBER_RULES)).toEqual(expect.arrayContaining(['project_context', 'team_message']));
    });
});
