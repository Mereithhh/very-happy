import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from './_default';
import { describeCron } from '@/screens/automations/automationPresentation';

/** B-772 (QA4 O6): English counts agree with their number (「1 members」). */
describe('English count copy is singular at 1', () => {
  it('sidebar team headcount (the QA4 「1 members」 row)', () => {
    const copy = readFileSync(new URL('../screens/sessions/teamNavigationCopy.ts', import.meta.url), 'utf8');
    expect(copy).toContain("headcount: (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`");
  });

  it('team, file, import and machine counts', () => {
    expect(en.teams.counts({ bots: 1, tasks: 1 })).toBe('1 teammate · 1 task');
    expect(en.teams.counts({ bots: 2, tasks: 0 })).toBe('2 teammates · 0 tasks');
    expect(en.tools.builtin.inspectSummary({ name: 'T', tasks: 1, bots: 1, messages: 1 })).toBe('T · 1 task · 1 member · 1 message');
    expect(en.tools.builtin.inspectSummary({ name: 'T', tasks: 2, bots: 3, messages: 4 })).toBe('T · 2 tasks · 3 members · 4 messages');
    expect(en.tools.desc.modifyingFiles({ count: 1 })).toBe('Modifying 1 file');
    expect(en.importClaudeHistory.batchImported({ count: 1 })).toBe('1 conversation imported');
    expect(en.historySearch.evicted({ count: 1 })).toMatch(/^1 older conversation is /);
  });

  it('every N minutes / hours says “every minute” / “hourly” at 1', () => {
    expect(describeCron('*/1 * * * *', 'en')).toBe('Every minute');
    expect(describeCron('*/5 * * * *', 'en')).toBe('Every 5 minutes');
    expect(describeCron('0 */1 * * *', 'en')).toBe('Hourly at :00');
  });

  it('component-local counts (diff comments, git files, pi agent) branch on 1', () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(read('../screens/session/diffComments/DiffCommentsBar.tsx')).toContain("comments.length === 1 ? 'Delete the 1 comment in this session?'");
    expect(read('../screens/session/git/GitActionDialog.tsx')).toContain("candidates.length === 1 ? 'The 1 file'");
    expect(read('../components/tools/piToolMapping.ts')).toContain("count === 1 ? '1 parallel task'");
  });
});
