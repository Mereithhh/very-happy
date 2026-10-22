import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Sidebar wiring (B-721 / B-762)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  const row = readFileSync(new URL('./SidebarTeamRow.tsx', import.meta.url), 'utf8');
  it('team nodes render through SidebarTeamRow only (one render path, tree lens only)', () => {
    expect(src.match(/<SidebarTeamRow\b/g)).toHaveLength(1);
    expect(src).not.toContain('className="sb-team-main"');
  });
  it('B-759: the row opens the team page; the menu offers team page, lead and settings', () => {
    expect(row).toContain("{ key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.href) }");
    expect(row).toContain("key: 'open-lead', label: copy.openLead");
    expect(row).toContain("{ key: 'settings', label: copy.settings, icon: Settings2, onSelect: () => props.onNavigate(target.settingsHref) }");
    expect(row).toContain('<ActionContextMenu items={items} sheetTitle={team.name}>');
    expect(row).not.toContain('sb-team-board');
  });
  it('B-759: the menu’s 团队设置 lands on the settings tab (?view=settings)', () => {
    const teams = readFileSync(new URL('../teams/TeamsScreen.tsx', import.meta.url), 'utf8');
    expect(teams).toContain('if (searchParams.get("view") === "settings") {\n      setView("settings");');
  });
  it('B-762: hints, folds and team nodes stay out of ⌘1–9 / reorder', () => {
    expect(src).toContain('.filter((r) => !r.teamInactiveFold && !r.teamEmptyHint && !r.projectEmptyHint && !r.team)');
    expect(src).toContain('const i = r.share || r.teamInactiveFold || r.teamEmptyHint || r.projectEmptyHint || r.team ? -1 : flat++;');
  });
  it('B-762 (D1): no 「项目」 area in the tag lens — the 项目 capability carries the badge', () => {
    expect(src).not.toContain('tag-lens:projects');
    expect(src).toContain('projectAttention: projectBadgeTotal');
  });
});
