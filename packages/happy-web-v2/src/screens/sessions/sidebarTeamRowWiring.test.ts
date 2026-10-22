import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Sidebar wiring (B-721)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  const row = readFileSync(new URL('./SidebarTeamRow.tsx', import.meta.url), 'utf8');
  it('every grouping view renders team headers through SidebarTeamRow (one render path)', () => {
    expect(src.match(/<SidebarTeamRow\b/g)).toHaveLength(1);
    expect(src).not.toContain('className="sb-team-main"');
    expect(src).toContain('const leadId = teamLeadSessionId(team);');
  });
  it('B-759: the row opens the team page; the menu offers team page, lead and settings', () => {
    expect(row).toContain("{ key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.href) }");
    expect(row).toContain("key: 'open-lead', label: copy.openLead");
    expect(row).toContain("{ key: 'settings', label: copy.settings, icon: Settings2, onSelect: () => props.onNavigate(target.settingsHref) }");
    expect(row).toContain('<ActionContextMenu items={items}>');
    expect(row).not.toContain('sb-team-board');
  });
  it('B-759: the menu’s 团队设置 lands on the settings tab (?view=settings)', () => {
    const teams = readFileSync(new URL('../teams/TeamsScreen.tsx', import.meta.url), 'utf8');
    expect(teams).toContain('if (searchParams.get("view") === "settings") {\n      setView("settings");');
  });
  it('B-759: the lead-only hint renders as a non-nav row outside ⌘1–9 / reorder', () => {
    expect(src).toContain('if (r.teamEmptyHint) return <div key={r.key} className="sb-team-child"><p className="sb-team-empty">{r.title}</p></div>;');
  });
});

describe('Sidebar wiring (B-756)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  it('the tag lens puts a 「项目」 area on top and keeps it out of ⌘1–9 / reorder', () => {
    expect(src).toContain("out.unshift(collapsibleSection('tag-lens:projects'");
    expect(src).toContain('.filter((r) => !r.teamInactiveFold && !r.teamEmptyHint && !r.projectEntry)');
    expect(src).toContain('const i = r.share || r.teamInactiveFold || r.teamEmptyHint || r.projectEntry ? -1 : flat++;');
  });
  it('outside the project lens a session row names its project', () => {
    expect(src).toContain("const chipProjects = projectsSnap.status === 'ready' && !(orderable && groupMode === 'project');");
    expect(src).toContain('projectChip={projectChipOf(r)}');
  });
  it('a project head carries ＋ / ⚙ and the shared project menu on right-click / long-press', () => {
    expect(src).toContain('{sec.label !== undefined && wrapProjectHead(sec.project, (');
    expect(src).toContain('onClick={() => navigate(projectSettingsPath(sec.project!.id))}');
    expect(src).toContain('<ActionContextMenu items={projectMenuItems(project, {');
  });
});
