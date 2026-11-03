import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teamExitMarkerPath } from './exitNotice';
import { teamInitialPrompt } from '@/daemon/teams/initialPrompt';
import { formatTeamMessage } from '@/daemon/teams/messageEnvelope';
import { createTeamLanguageBackfill, teamLanguageMarkerPath } from './languageBackfill';
import { teamLanguageRule } from './language';

const zh = { name: 'Chinese (中文)', code: 'zh' as const };
let home: string;
let scope: string;
const backfill = () => createTeamLanguageBackfill({ home, sessionId: () => 's1', scopeFile: () => scope });
const run = (text: string, inj = backfill()) => inj.decorate(text, text);

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'b877c-'));
    scope = join(home, 'scope.json');
    writeFileSync(scope, '{}');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('B-877c: a team session without the language rule gets it once', () => {
    it('goes in front of the next user turn, in the language of that turn', () => {
        const text = '不是说了10个key吗，怎么搞半天又3个key';
        expect(run(text)).toBe(`${teamLanguageRule(zh)}\n${text}`);
    });
    it('only once, including after a restart', () => {
        const inj = backfill();
        run('第一条中文消息在这里', inj);
        expect(run('第二条中文消息在这里', inj)).toBe('第二条中文消息在这里');
        expect(run('重启之后的中文消息', backfill())).toBe('重启之后的中文消息');
        expect(JSON.parse(readFileSync(teamLanguageMarkerPath(home, 's1'), 'utf8')).via).toBe('backfill');
    });
    it('a session whose prompt already has the rule is left alone, then and after', () => {
        const prompt = teamInitialPrompt('修复这个问题并提交修复结果', true, '/tmp/x');
        expect(run(prompt)).toBe(prompt);
        expect(run('下一条中文用户消息')).toBe('下一条中文用户消息');
        expect(JSON.parse(readFileSync(teamLanguageMarkerPath(home, 's1'), 'utf8')).via).toBe('prompt');
    });
    it('an envelope turn takes the language from its footer, not from a sender\'s words', () => {
        const envelope = formatTeamMessage({ id: 'm1', taskId: 't1', sender: 'Dev', body: '이것은 한국어 제출입니다', language: zh });
        expect(run(envelope)).toBe(`${teamLanguageRule(zh)}\n${envelope}`);
    });
    it('a lead\'s briefing-board lines do not outvote a short Chinese message', () => {
        const text = '[Briefing board] 1 open: decision "ship it" key=ship-it 12m\n[Briefing board] Answer owner items in this turn or settle them with owner_board_update / owner_board_resolve (owner_board_list shows ids); do not repeat open decisions in chat.\n进展怎么样了';
        expect(run(text)).toBe(`${teamLanguageRule(zh)}\n${text}`);
    });
    it('names no language it cannot tell, and reads the user\'s words, not other injections', () => {
        expect(run('ok')).toBe(`${teamLanguageRule(null)}\nok`);
        rmSync(teamLanguageMarkerPath(home, 's1'));
        expect(backfill().decorate('[项目说明：全部用中文写作]\nok', 'ok')).toBe(`${teamLanguageRule(null)}\n[项目说明：全部用中文写作]\nok`);
    });
    it('an unwritable marker skips the rule rather than repeating it every turn', () => {
        writeFileSync(join(home, 'teams'), 'not a directory');
        expect(run('这是一条中文的消息')).toBe('这是一条中文的消息');
    });
});

describe('B-877c: everything else is untouched', () => {
    it('an ordinary session (no scope file) gets nothing and records nothing', () => {
        rmSync(scope);
        expect(run('这是一条普通会话消息')).toBe('这是一条普通会话消息');
        expect(existsSync(teamLanguageMarkerPath(home, 's1'))).toBe(false);
    });
    it('a session that left its team gets nothing', () => {
        mkdirSync(join(home, 'teams', 'exited'), { recursive: true });
        writeFileSync(teamExitMarkerPath(home, 's1'), JSON.stringify({ teamId: 't' }));
        expect(run('退出团队之后的消息')).toBe('退出团队之后的消息');
    });
    it('no session id yet: waits, without using up the rule', () => {
        const none = createTeamLanguageBackfill({ home, sessionId: () => null, scopeFile: () => scope });
        expect(none.decorate('这是一条中文的消息', '这是一条中文的消息')).toBe('这是一条中文的消息');
        expect(run('这是一条中文的消息')).toContain('## Language');
    });
    it('finds a team_create scope by session id, and the spawned scope through the env', () => {
        const noScopeDep = createTeamLanguageBackfill({ home, sessionId: () => 's1' });
        const previous = process.env.VH_TEAM_SCOPE_FILE;
        try {
            delete process.env.VH_TEAM_SCOPE_FILE;
            expect(noScopeDep.decorate('这是一条中文的消息', '这是一条中文的消息')).not.toContain('## Language');
            mkdirSync(join(home, 'teams', 'scopes'), { recursive: true });
            writeFileSync(join(home, 'teams', 'scopes', 's1.json'), '{}');
            expect(noScopeDep.decorate('这是一条中文的消息', '这是一条中文的消息')).toContain('## Language');
            rmSync(teamLanguageMarkerPath(home, 's1'));
            rmSync(join(home, 'teams', 'scopes', 's1.json'));
            process.env.VH_TEAM_SCOPE_FILE = scope;
            expect(noScopeDep.decorate('这是一条中文的消息', '这是一条中文的消息')).toContain('## Language');
        } finally { if (previous === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = previous; }
    });
});
