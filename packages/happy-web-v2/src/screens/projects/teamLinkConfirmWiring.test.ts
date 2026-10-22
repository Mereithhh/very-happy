import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-772 (QA4 O3): 「关联已有团队」 silently moved a team out of its project. Both
 * entry points (project overview, project settings) ask first when
 * `teamMoveSource` finds another project, and only then call attachTeam.
 */
describe('link existing team asks before moving it between projects', () => {
  for (const file of ['./ProjectScreen.tsx', './ProjectSettingsScreen.tsx']) {
    it(file, () => {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      const body = src.slice(src.indexOf('teamMoveSource({ id: teamId }'));
      const confirm = body.indexOf('if (from && !(await Modal.confirm(c.moveTeamTitle, c.moveTeamBody(');
      const attach = body.indexOf('projectsApi.attachTeam(');
      expect(confirm).toBeGreaterThan(0);
      expect(attach).toBeGreaterThan(confirm);
    });
  }

  it('the copy names both projects, in both languages', () => {
    const copy = readFileSync(new URL('./projectCopy.ts', import.meta.url), 'utf8');
    expect(copy).toContain('`团队「${team}」将从「${from}」移到「${to}」');
    expect(copy).toContain('`“${team}” moves from “${from}” to “${to}”.');
  });
});
