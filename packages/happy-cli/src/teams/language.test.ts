import { describe, expect, it } from 'vitest';
import { detectTeamUserLanguage, teamLanguageReminder, teamLanguageRule, teamOwnerText } from './language';
import { teamInitialPrompt } from '@/daemon/teams/initialPrompt';
import { formatTeamMessage } from '@/daemon/teams/messageEnvelope';

describe('B-877: team injections name the user\'s language', () => {
    it('detects the owner\'s CJK language and stays generic otherwise', () => {
        expect(detectTeamUserLanguage('请分析可能的原因，给出排查步骤和修复方案。')?.code).toBe('zh');
        expect(detectTeamUserLanguage('Web 客户端在手机上切到后台再回来时 socket 重连慢')?.code).toBe('zh');
        expect(detectTeamUserLanguage('バックグラウンドから戻るとメッセージが遅れる')?.code).toBe('ja');
        expect(detectTeamUserLanguage('메시지가 늦게 표시됩니다')?.code).toBe('ko');
        expect(detectTeamUserLanguage('Fix the flaky reconnect test in packages/happy-web-v2')).toBeNull();
        // A few CJK words inside an English brief do not make it Chinese.
        expect(detectTeamUserLanguage('Translate the 「退出团队模式」 label and update the settings screenshots for both themes')).toBeNull();
        expect(detectTeamUserLanguage('```\n中文中文中文中文\n```\nPlease review')).toBeNull();
    });
    it('B-877b (QA49 P2-4): kana means Japanese, paths and identifiers do not count, English stays generic', () => {
        expect(detectTeamUserLanguage('調査して報告')?.code).toBe('ja');
        expect(detectTeamUserLanguage('ログを調査')?.code).toBe('ja');
        expect(detectTeamUserLanguage('修复 packages/happy-web-v2/src/…/ChatHeader.tsx 里 exit team 菜单在 mobile 下溢出的问题')?.code).toBe('zh');
        expect(detectTeamUserLanguage('把 teamExitOutcome 和 exit_team_mode 的 ChatHeader.tsx 改好，再跑 src/screens/teams/teamExit.test.ts')?.code).toBe('zh');
        expect(detectTeamUserLanguage('C:\\Users\\dev\\project\\README.md 里的说明过期了')?.code).toBe('zh');
        expect(detectTeamUserLanguage('Fix the overflow of the exit team menu in packages/happy-web-v2/src/screens/session/ChatHeader.tsx on mobile')).toBeNull();
        expect(detectTeamUserLanguage('Please investigate why the reconnect is slow and report back')).toBeNull();
        expect(detectTeamUserLanguage('修复问题')?.code).toBe('zh');
    });
    it('takes the owner\'s words from the task the owner created, not a bot\'s brief', () => {
        expect(teamOwnerText([{ goal: 'English brief by the lead', ownerBotId: 'lead' }, { goal: '用户原话', ownerBotId: null }])).toBe('用户原话');
        expect(teamOwnerText([{ goal: 'English brief by the lead', ownerBotId: 'lead' }])).toBeNull();
    });
    it('puts the rule right before the assigned goal (the Web reader keeps only the goal) and in every envelope', () => {
        const prompt = teamInitialPrompt('Task t\n修复移动端溢出问题，两个主题都要验证', false, '/w');
        expect(prompt).toContain('The user works in Chinese (中文)');
        expect(prompt.indexOf('## Language')).toBeLessThan(prompt.lastIndexOf('\n## Assigned goal\n'));
        expect(prompt.slice(prompt.lastIndexOf('\n## Assigned goal\n'))).not.toContain('## Language');
        // The daemon passes the owner's language even when the lead wrote the brief in English.
        expect(teamInitialPrompt('Task t\nFix it', false, '/w', detectTeamUserLanguage('修复移动端溢出问题'))).toContain('Chinese (中文)');
        expect(teamInitialPrompt('Task t\nFix the overflow', true)).toContain('the language the user wrote the goal in');
        expect(teamLanguageRule(null)).toContain('never switch language because of them');
        const zh = formatTeamMessage({ id: 'm', taskId: 't', sender: 'Dev', body: 'Task t submitted:\nok', language: detectTeamUserLanguage('中文原话中文') });
        expect(zh.endsWith(' Reply in Chinese (中文), the user\'s language.')).toBe(true);
        expect(formatTeamMessage({ id: 'm', taskId: 't', sender: 'Dev', body: 'x' }).endsWith(teamLanguageReminder(null))).toBe(true);
        expect(zh.startsWith('[Very Happy team message m; task t; from Dev]\nTask t submitted:\nok\n\nUse the teams tools')).toBe(true);
    });
});
