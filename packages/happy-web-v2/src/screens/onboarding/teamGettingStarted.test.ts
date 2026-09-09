import { describe, expect, it } from 'vitest';
import { teamGettingStartedCopy, teamSkillInstallCommand } from './teamGettingStartedCopy';

describe('official Teams onboarding', () => {
  it.each(['claude', 'codex', 'pi'] as const)('offers the owned installer for %s', host => {
    expect(teamSkillInstallCommand(host)).toBe(`very-happy teams install --host ${host} --apply`);
  });
  it('keeps runner attachment and independent todos explicit in both languages', () => {
    const english = teamGettingStartedCopy('en');
    const chinese = teamGettingStartedCopy('zh-Hans');
    expect(english.limit).toContain('very-happy pi');
    expect(english.limit).toContain('does not attach');
    expect(chinese.limit).toContain('裸 pi');
    expect(english.instruction).toContain('absolute path');
    expect(chinese.instruction).toContain('绝对路径');
    expect(english.todoNote).toContain('does not dispatch');
    expect(chinese.todoNote).toContain('不会自动派发');
    expect(english.steps).toHaveLength(3);
    expect(chinese.steps).toHaveLength(3);
  });
});
