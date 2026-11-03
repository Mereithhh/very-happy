import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTeamExitNotice, readTeamExitMarker, teamExitedMessage, teamExitMarkerPath, teamExitNoticeText } from './exitNotice';
import { MISSING_TEAM_SCOPE_MESSAGE, NO_TEAM_SCOPE_MESSAGE, noTeamScopeMessage, teamRefusalMessage } from './client';

let home: string;
beforeEach(() => {
    const root = join(homedir(), 'code/github/skills/tmp/vh-team-B-877b/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'notice-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const zh = { name: 'Chinese (中文)', code: 'zh' as const };
function exited(sessionId: string, marker: Record<string, unknown> = { teamId: 'team-1', teamName: 'qa49-exit-cli', managed: true, at: 1, language: zh, reason: 'exit' }) {
    mkdirSync(join(home, 'teams', 'exited'), { recursive: true });
    writeFileSync(teamExitMarkerPath(home, sessionId), JSON.stringify(marker), { mode: 0o600 });
}

describe('B-877b: a session that left its team is told so, plainly', () => {
    it('every team tool answers "archived, ordinary session, do it yourself" — never "call team_inspect again"', () => {
        exited('s1');
        const text = noTeamScopeMessage('s1', home);
        expect(text).toBe(teamExitedMessage(readTeamExitMarker(home, 's1')!));
        expect(text).toContain('Team "qa49-exit-cli" is archived and this session has left team mode; it is an ordinary session now.');
        expect(text).toContain('Do what the user asks yourself');
        expect(text).toContain('Reply in Chinese (中文)');
        for (const refusal of [text, NO_TEAM_SCOPE_MESSAGE, MISSING_TEAM_SCOPE_MESSAGE, teamRefusalMessage(409, { error: 'team_archived' })]) {
            expect(refusal).not.toMatch(/team_inspect again|call team_inspect/);
            expect(refusal).toMatch(/[Rr]etry/);
        }
    });
    it('a marker from before B-877b (no name, no language) still names the team and a generic language rule', () => {
        exited('s1', { teamId: 'team-1', managed: true, at: 1 });
        expect(noTeamScopeMessage('s1', home)).toContain('Team "team-1" is archived');
        expect(noTeamScopeMessage('s1', home)).toContain('Reply in the user\'s language');
    });
    it('without a marker the plain refusal no longer suggests the scope may come back', () => {
        const previous = process.env.VH_TEAM_SCOPE_FILE;
        try {
            delete process.env.VH_TEAM_SCOPE_FILE;
            expect(noTeamScopeMessage('s2', home)).toBe(NO_TEAM_SCOPE_MESSAGE);
            process.env.VH_TEAM_SCOPE_FILE = join(home, 'missing.json');
            expect(noTeamScopeMessage('s2', home)).toBe(MISSING_TEAM_SCOPE_MESSAGE);
        } finally { if (previous === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = previous; }
    });
    it('a team archived under a live session reads as final', () => {
        expect(teamRefusalMessage(409, { error: 'team_archived' })).toContain('this team is archived, which is final');
    });
});

describe('B-877b: one note before the first turn after leaving the team', () => {
    it('goes out exactly once, persisted across a restart, in the language of the user\'s message', () => {
        exited('s1');
        const first = createTeamExitNotice({ home, sessionId: () => 's1' });
        const turn = first.decorate('团队那边现在怎么样了？请继续推进');
        expect(turn).toBe(`${teamExitNoticeText(readTeamExitMarker(home, 's1')!, zh)}\n团队那边现在怎么样了？请继续推进`);
        expect(turn).toMatch(/^\[Very Happy: team mode ended\] Team "qa49-exit-cli" was archived when the user exited team mode\./);
        expect(turn).toContain('do not wait for or ask the user to restore team access');
        expect(turn).toContain('carry on with the work yourself');
        expect(JSON.parse(readFileSync(teamExitMarkerPath(home, 's1'), 'utf8')).noticeAt).toEqual(expect.any(Number));
        expect(first.decorate('next')).toBe('next');
        // A relaunched wrapper (new process, same home) does not repeat it.
        expect(createTeamExitNotice({ home, sessionId: () => 's1' }).decorate('again')).toBe('again');
        // The marker still drives the tool refusals.
        expect(noTeamScopeMessage('s1', home)).toContain('has left team mode');
    });
    it('follows the user\'s message language over the owner\'s, and says why the team ended', () => {
        exited('s1', { teamId: 't', teamName: 'n', language: zh, reason: 'archived' });
        const turn = createTeamExitNotice({ home, sessionId: () => 's1' }).decorate('How is the team doing? Please keep going.');
        expect(turn).toContain('Team "n" was archived while this session was stopped.');
        expect(turn).toContain('Reply in the user\'s language');
        exited('s2', { teamId: 't', teamName: 'n', reason: 'exit' });
        expect(createTeamExitNotice({ home, sessionId: () => 's2' }).decorate('チームの状況はどうですか？続けてください')).toContain('Reply in Japanese (日本語)');
        exited('s3', { teamId: 't', teamName: 'n', language: zh });
        expect(createTeamExitNotice({ home, sessionId: () => 's3' }).decorate('ok?')).toContain('Reply in Chinese (中文)');
    });
    it('leaves sessions that never left a team untouched', () => {
        const notice = createTeamExitNotice({ home, sessionId: () => 's9' });
        expect(notice.decorate('hello')).toBe('hello');
        expect(createTeamExitNotice({ home, sessionId: () => undefined }).decorate('hello')).toBe('hello');
    });
});
