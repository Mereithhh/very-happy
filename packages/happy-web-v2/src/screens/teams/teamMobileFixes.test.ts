// @vitest-environment happy-dom
/** B-798 G (P2-4, P2-5): team 404 vs unavailable, and the default short team name. */
import { describe, expect, it } from 'vitest';
import { teamLoadFailure, teamNameFromGoal } from './teamPresentation';
import { FIRST_USE_COPY } from './firstUseCopy';

describe('teamLoadFailure', () => {
  it('a missing team is "not found", never "teams are off"', () => {
    expect(teamLoadFailure(404, 'team_not_found')).toBe('notFound');
  });
  it('the server switch, a 403 and a bare 404 keep the unavailable explanation', () => {
    expect(teamLoadFailure(404, 'teams_disabled')).toBe('unavailable');
    expect(teamLoadFailure(403, 'forbidden')).toBe('unavailable');
    expect(teamLoadFailure(404, 'http_404')).toBe('unavailable');
  });
  it('anything else is an ordinary error', () => {
    expect(teamLoadFailure(500, 'boom')).toBe('error');
    expect(teamLoadFailure(409, 'conflict')).toBe('error');
  });
  it('has copy in both languages that does not claim the feature is off', () => {
    for (const c of [FIRST_USE_COPY.en, FIRST_USE_COPY.zh]) {
      expect(c.notFound).toBeTruthy();
      expect(c.notFound).not.toBe(c.unavailable);
      expect(c.notFoundHint).toBeTruthy();
      expect(c.allTeams).toBeTruthy();
    }
  });
});

describe('teamNameFromGoal', () => {
  it('keeps a short goal as is', () => {
    expect(teamNameFromGoal('  修复登录页  ')).toBe('修复登录页');
    expect(teamNameFromGoal('Ship the fix')).toBe('Ship the fix');
  });
  it('uses the first line; a long one shortens to its first sentence', () => {
    expect(teamNameFromGoal('重构支付网关。拆成三个服务并补测试\n第二行')).toBe('重构支付网关。拆成三个服务并补测试');
    expect(teamNameFromGoal('重构支付网关，拆成订单、退款、对账三个服务。每个服务补齐集成测试并在预发环境验证全部回调链路')).toBe('重构支付网关，拆成订单、退款、对账三个服务');
    expect(teamNameFromGoal('Review the API docs. Then fix the worst bugs and add tests for each one of them.')).toBe('Review the API docs');
  });
  it('falls back to the first clause, then a 40-character cut with an ellipsis', () => {
    const audit = '[QA] B-798 走查用：负责人只回复一句「收到」然后对根任务 team_submit 结果「OK」，不要创建任何成员、不要改文件。';
    const name = teamNameFromGoal(audit);
    expect(Array.from(name).length).toBeLessThanOrEqual(40);
    expect(name.startsWith('[QA] B-798 走查用')).toBe(true);
    const long = 'x'.repeat(100);
    expect(teamNameFromGoal(long)).toBe(`${'x'.repeat(39)}…`);
  });
  it('never splits a surrogate pair', () => {
    const name = teamNameFromGoal('😀'.repeat(60));
    expect(Array.from(name)).toHaveLength(40);
    expect(name.endsWith('…')).toBe(true);
  });
});
