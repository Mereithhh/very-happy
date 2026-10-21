import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProjectDigest, ProjectSessionContext } from '@slopus/happy-wire';
import { PROJECT_HINT, buildDigestLine, buildFirstTurnPrefix, chooseVariant, formatContextForTool, prependToMessage, variantText } from './prompt';

const ctx = (over: Partial<ProjectSessionContext> = {}): ProjectSessionContext => ({
    project: { id: 'p1', name: 'very-happy', goal: null, instructions: 'Use pnpm.', instructionsVersion: 7 },
    via: 'explicit', team: null,
    decisions: [{ id: 'd1', seq: 3, title: 'server before CLI', createdAt: 1 }],
    log: [], sessions: [{ sessionId: 'peer-session-1', projectId: 'p1', machineId: 'm', title: 'fix sidebar', agent: 'claude', machine: 'dev-sg', branch: 'b-640', state: 'running', doing: 'writing tests', injectedInstructionsVersion: 7, capabilities: ['project-v1'], updatedAt: 1 }],
    unread: [], asOf: new Date(2026, 9, 21, 9, 5).getTime(), previousReadAt: 0, ...over,
});

describe('project injection texts (spec §4)', () => {
    // The spec (§4) is the source of truth for the wording: every text must appear there verbatim.
    const spec = readFileSync(new URL('../../../../specs/2026-10-projects.md', import.meta.url), 'utf8');
    it('H is the constant one-liner from the spec, ≤200 chars', () => {
        expect(spec).toContain(PROJECT_HINT);
        expect(PROJECT_HINT.length).toBeLessThanOrEqual(200);
        expect(PROJECT_HINT).not.toMatch(/ALWAYS|MUST/);
    });
    it('variant texts are the spec wording with the placeholders filled', () => {
        expect(spec).toContain(variantText('member', '{projectName}'));
        expect(spec).toContain(variantText('team-member', '{projectName}', '{teamName}'));
        expect(spec).toContain(variantText('team-lead', '{projectName}', '{teamName}'));
        expect(spec).toContain(variantText('quiet', '{projectName}'));
        for (const v of ['member', 'team-lead', 'team-member', 'quiet'] as const) expect(variantText(v, 'x', 'y')).not.toMatch(/ALWAYS|MUST/);
    });
    it('chooses team-member for team sessions, quiet for automation, member otherwise', () => {
        expect(chooseVariant({ via: 'team', team: { id: 't', name: 'n' } })).toBe('team-member');
        expect(chooseVariant({ via: 'team', team: { id: 't', name: 'n', lead: false } })).toBe('team-member');
        // B-726: the lead records the team's decisions; an older server (no `lead`) keeps the member wording.
        expect(chooseVariant({ via: 'team', team: { id: 't', name: 'n', lead: true } })).toBe('team-lead');
        expect(chooseVariant({ via: 'automation', team: null })).toBe('quiet');
        expect(chooseVariant({ via: 'explicit', team: null })).toBe('member');
    });
});

describe('first-turn prefix (P)', () => {
    it('data block, then variant, then a separator before the user message; the version is reported', () => {
        const built = buildFirstTurnPrefix(ctx())!;
        expect(built.instructionsVersion).toBe(7);
        expect(built.prefix.startsWith('[Very Happy project "very-happy" · instructions v7 · as of 09:05]\nUse pnpm.\nDecisions in effect:\n#3 server before CLI\n')).toBe(true);
        expect(built.prefix).toContain('Other active sessions as of 09:05, may be stale:\nfix sidebar · claude · dev-sg/b-640 · writing tests');
        expect(built.prefix.endsWith('say so.\n---\n')).toBe(true);
        expect(prependToMessage('hello', built.prefix).endsWith('---\nhello')).toBe(true);
    });
    it('omits empty sections; other sessions only for an explicit member', () => {
        const bare = buildFirstTurnPrefix(ctx({ decisions: [], project: { id: 'p', name: 'n', goal: null, instructions: '', instructionsVersion: 0 } }))!;
        expect(bare.prefix).not.toContain('Decisions in effect');
        expect(bare.prefix.split('\n')[1]).toBe('Other active sessions as of 09:05, may be stale:');
        expect(buildFirstTurnPrefix(ctx({ via: 'automation' }))!.prefix).not.toContain('Other active sessions');
        expect(buildFirstTurnPrefix(ctx({ via: 'team', team: { id: 't', name: 'B-640' } }))!.prefix).toContain('as a member of team "B-640"');
        expect(buildFirstTurnPrefix(ctx({ via: 'team', team: { id: 't', name: 'B-640' } }))!.prefix).not.toContain('Other active sessions');
    });
    it('shows at most 3 unread and 8 sessions/decisions', () => {
        const many = buildFirstTurnPrefix(ctx({
            unread: Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, fromSessionId: 'peer-session-1', body: 'x'.repeat(300), createdAt: i })),
            decisions: Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, seq: i, title: `d${i}`, createdAt: i })),
        }), { label: () => 'fix sidebar' })!;
        expect(many.prefix.match(/^from fix sidebar: /gm)).toHaveLength(3);
        expect(many.prefix.match(/^#\d+ d\d+$/gm)).toHaveLength(8);
        expect(many.prefix).toContain(`${'x'.repeat(119)}…`);
    });
    it('no project → no prefix; a structured message is never rewritten', () => {
        expect(buildFirstTurnPrefix(ctx({ project: null }))).toBeNull();
        const blocks = [{ type: 'text', text: 'hi' }];
        expect(prependToMessage(blocks, 'prefix')).toBe(blocks);
        expect(prependToMessage('hi', null)).toBe('hi');
    });
});

describe('next-turn digest (D)', () => {
    const d = (over: Partial<ProjectDigest> = {}): ProjectDigest => ({ projectId: 'p1', name: 'very-happy', instructions: null, decisions: [], revoked: [], messages: [], asOf: 1, ...over });
    it('is null when nothing changed or the session left', () => {
        expect(buildDigestLine(d())).toBeNull();
        expect(buildDigestLine(d({ projectId: null, name: null, instructions: { version: 2, summary: null } }))).toBeNull();
    });
    it('one bracketed line with version, decisions and messages', () => {
        const line = buildDigestLine(d({ instructions: { version: 8, summary: 'add rule' }, decisions: [{ id: 'x', seq: 12, title: 'ship server first' }], messages: [{ id: 'm', fromSessionId: 'abcdefgh123', body: 'heads up', createdAt: 1 }] }))!;
        expect(line).toBe('[Project "very-happy" since your last turn: instructions now v8 — add rule; decision #12: ship server first; 1 message from abcdefgh: heads up]');
        expect(line.split('\n')).toHaveLength(1);
    });
    it('stays bounded', () => {
        const line = buildDigestLine(d({ decisions: Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, seq: i, title: 'y'.repeat(200) })), messages: [{ id: 'm', fromSessionId: 's', body: 'z'.repeat(5000), createdAt: 1 }] }))!;
        expect(line.length).toBeLessThanOrEqual(600);
    });
});

describe('project_context tool text', () => {
    it('≤2KB by default, full on request, "not in a project" otherwise', () => {
        expect(formatContextForTool(ctx({ project: null }))).toBe('not in a project');
        const big = ctx({ project: { id: 'p', name: 'n', goal: null, instructions: 'i'.repeat(8000), instructionsVersion: 1 } });
        expect(formatContextForTool(big).length).toBeLessThanOrEqual(2048);
        expect(formatContextForTool(big, { full: true }).length).toBeGreaterThan(8000);
        expect(formatContextForTool(ctx({ previousReadAt: 5 }))).not.toContain('Instructions:');
        expect(formatContextForTool(ctx(), { section: 'sessions' })).toContain('peer-session-1 · fix sidebar');
    });
});
